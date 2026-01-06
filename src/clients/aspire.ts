import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export interface AspireTransaction {
  id: string;
  account_id: string;
  datetime: string; // ISO 8601
  amount: number; // Amount in cents (100 = 1.00)
  currency_code: string; // USD, EUR, SGD
  type: string; // e.g., "card_transaction"
  status: string; // e.g., "completed"
  reference: string | null;
  counterparty_name: string | null;
  balance: number; // Balance in cents
  additional_info?: {
    spend_category?: string;
    card_number?: string;
  };
}

export interface AspireResponse {
  data: AspireTransaction[];
  metadata?: {
    total: number;
  };
}

class AspireService {
  private proxyUrl: string;

  constructor() {
    this.proxyUrl = config.aspireProxyUrl;
    logger.info('Aspire Bank client initialized');
  }

  /**
   * Проверяет, настроен ли Aspire клиент
   */
  isConfigured(): boolean {
    return !!this.proxyUrl;
  }

  /**
   * Получает транзакции из Aspire Bank через прокси
   */
  async getTransactions(
    accountId: string,
    startDate: string,
    retries = 2
  ): Promise<AspireTransaction[]> {
    const url = `${this.proxyUrl}/aspire?account_id=${encodeURIComponent(accountId)}&start_date=${encodeURIComponent(startDate)}`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          logger.info(`Retry attempt ${attempt}/${retries} for Aspire account ${accountId}...`);
          // Wait before retry (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }

        logger.debug(`Fetching Aspire transactions from: ${url}`);
        
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'YNAB-Sync-App/1.0'
          },
          signal: AbortSignal.timeout(60000) // 60 second timeout
        });

        const responseText = await response.text();
        
        if (!response.ok) {
          logger.error(`Aspire API returned ${response.status}: ${responseText}`);
          
          if (response.status === 500 && attempt < retries) {
            logger.warn('Server error (500), will retry...');
            continue; // Retry on server error
          }
          
          throw new Error(`Aspire API error: ${response.status} - ${responseText}`);
        }

        const data = JSON.parse(responseText) as AspireResponse;
        
        logger.info(`✅ Fetched ${data.data?.length || 0} transactions from Aspire account ${accountId}`);
        
        return data.data || [];
      } catch (error: any) {
        if (attempt === retries) {
          logger.error(`❌ Failed to fetch Aspire transactions after ${retries + 1} attempts:`, error);
          throw error;
        }
      }
    }
    
    return []; // Should never reach here
  }

  /**
   * Конвертирует сумму из Aspire (центы) в YNAB milliunits
   * Aspire: 100 = 1.00 (cents)
   * YNAB: 1000 = 1.00 (milliunits)
   */
  convertToMilliunits(aspireAmount: number): number {
    return Math.round(aspireAmount * 10);
  }

  /**
   * Нормализует дату из Aspire в YYYY-MM-DD для YNAB
   */
  normalizeDate(aspireDateTime: string): string {
    return aspireDateTime.split('T')[0];
  }

  /**
   * Генерирует уникальный import_id для YNAB (макс 36 символов)
   * Используем только первые 8 символов account_id + transaction_id
   */
  generateImportId(transaction: AspireTransaction): string {
    // ASPIRE: + первые 8 символов account_id + : + первые 20 символов transaction_id = 36 символов
    const accountPrefix = transaction.account_id.substring(0, 8);
    const txId = transaction.id.substring(0, 20);
    return `ASP:${accountPrefix}:${txId}`;
  }

  /**
   * Очищает counterparty name (убирает лишний текст после FACEBK и т.п.)
   */
  cleanCounterpartyName(name: string | null): string | null {
    if (!name) return null;
    
    // Если начинается с FACEBK, оставляем только FACEBK
    if (name.startsWith('FACEBK')) {
      return 'FACEBK';
    }
    
    return name;
  }
}

export const aspire = new AspireService();

