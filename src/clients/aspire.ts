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
   * Проверяет, является ли ответ Cloudflare Challenge страницей
   */
  private isCloudflareChallenge(responseText: string): boolean {
    return responseText.includes('Just a moment...') ||
           responseText.includes('cf-challenge') ||
           responseText.includes('challenge-platform') ||
           responseText.includes('Enable JavaScript and cookies to continue');
  }

  /**
   * Получает транзакции из Aspire Bank через прокси
   */
  async getTransactions(
    accountId: string,
    startDate: string,
    retries = 3
  ): Promise<AspireTransaction[]> {
    const url = `${this.proxyUrl}/aspire?account_id=${encodeURIComponent(accountId)}&start_date=${encodeURIComponent(startDate)}`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          logger.info(`Retry attempt ${attempt}/${retries} for Aspire account ${accountId}...`);
          // Wait before retry (exponential backoff with longer delays for Cloudflare)
          const delay = Math.min(Math.pow(2, attempt) * 2000, 30000); // Max 30 seconds
          logger.info(`Waiting ${delay / 1000} seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        logger.debug(`Fetching Aspire transactions from: ${url}`);
        
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
          },
          signal: AbortSignal.timeout(60000) // 60 second timeout
        });

        const responseText = await response.text();
        
        // Проверяем на Cloudflare Challenge
        if (this.isCloudflareChallenge(responseText)) {
          logger.warn(`⚠️  Cloudflare Challenge detected (attempt ${attempt + 1}/${retries + 1})`);
          
          if (attempt < retries) {
            logger.info('Will retry after delay...');
            continue; // Retry
          } else {
            throw new Error('Cloudflare Challenge: Proxy server is blocked by Cloudflare. Please try again later or check proxy server status.');
          }
        }
        
        if (!response.ok) {
          // Если это не Cloudflare challenge, но статус не OK
          if (this.isCloudflareChallenge(responseText)) {
            // Двойная проверка
            if (attempt < retries) {
              logger.warn('Cloudflare Challenge detected in error response, will retry...');
              continue;
            } else {
              throw new Error('Cloudflare Challenge: Proxy server is blocked by Cloudflare. Please try again later.');
            }
          }
          
          logger.error(`Aspire API returned ${response.status}: ${responseText.substring(0, 200)}...`);
          
          if (response.status === 500 && attempt < retries) {
            logger.warn('Server error (500), will retry...');
            continue; // Retry on server error
          }
          
          if (response.status === 429 && attempt < retries) {
            logger.warn('Rate limit (429), will retry with longer delay...');
            await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second delay for rate limit
            continue;
          }
          
          throw new Error(`Aspire API error: ${response.status} - ${responseText.substring(0, 200)}`);
        }

        // Проверяем, что ответ - это JSON, а не HTML
        if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
          if (this.isCloudflareChallenge(responseText)) {
            if (attempt < retries) {
              logger.warn('Received HTML instead of JSON (Cloudflare Challenge), will retry...');
              continue;
            } else {
              throw new Error('Cloudflare Challenge: Proxy server returned HTML instead of JSON. Please try again later.');
            }
          }
          throw new Error('Invalid response: Expected JSON but received HTML');
        }

        const data = JSON.parse(responseText) as AspireResponse;
        
        logger.info(`✅ Fetched ${data.data?.length || 0} transactions from Aspire account ${accountId}`);
        
        return data.data || [];
      } catch (error: any) {
        if (error.name === 'AbortError' || error.name === 'TimeoutError') {
          logger.error(`Request timeout after 60 seconds (attempt ${attempt + 1}/${retries + 1})`);
          if (attempt < retries) {
            continue;
          }
        }
        
        if (attempt === retries) {
          logger.error(`❌ Failed to fetch Aspire transactions after ${retries + 1} attempts:`, error.message);
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

