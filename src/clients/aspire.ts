import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { proxyFetch, isProxyConfigured } from '../utils/proxyFetch.js';

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
    per_page?: number;
    current_page?: number;
    next_page_url?: string;
  };
}

// Кэш для токена
interface TokenCache {
  access_token: string | null;
  expires_at: number | null;
}

class AspireService {
  // Закомментировано: использование прокси
  // private proxyUrl: string;
  private tokenCache: TokenCache = {
    access_token: null,
    expires_at: null
  };
  private readonly apiBaseUrl = 'https://api.aspireapp.com/public/v1';

  constructor() {
    // Закомментировано: использование прокси
    // this.proxyUrl = config.aspireProxyUrl;
    logger.info('Aspire Bank client initialized (direct API access)');
  }

  /**
   * Проверяет, настроен ли Aspire клиент
   */
  isConfigured(): boolean {
    // Проверяем наличие credentials вместо proxy URL
    return !!(config.aspireClientId && config.aspireClientSecret);
  }

  /**
   * Получает access token от Aspire API
   */
  private async getAccessToken(): Promise<string> {
    // Проверяем, есть ли валидный токен в кэше
    if (this.tokenCache.access_token && this.tokenCache.expires_at && Date.now() < this.tokenCache.expires_at) {
      logger.debug('✅ Using cached Aspire access token');
      return this.tokenCache.access_token;
    }

    try {
      logger.info('🔄 Getting new Aspire access token...');
      const response = await proxyFetch(`${this.apiBaseUrl}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: config.aspireClientId,
          client_secret: config.aspireClientSecret
        }),
        timeout: 10000,
        useProxyOn403: true // Use QuotaGuard proxy on IP restriction error
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get access token: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      // Кэшируем токен с учетом времени жизни
      const expiresIn = parseInt(data.expires_in) * 1000; // конвертируем в миллисекунды
      this.tokenCache = {
        access_token: data.access_token,
        expires_at: Date.now() + expiresIn - 60000 // вычитаем 1 минуту для безопасности
      };

      logger.info(`✅ Aspire token cached, expires in ${Math.round(expiresIn/1000)}s`);
      return data.access_token;
    } catch (error: any) {
      logger.error('❌ Aspire Token Error:', error.message);
      throw error;
    }
  }

  /**
   * Получает одну страницу транзакций из Aspire API
   */
  private async fetchPage(accountId: string, startDate: string, page: number = 1): Promise<AspireResponse> {
    const accessToken = await this.getAccessToken();

    const url = new URL(`${this.apiBaseUrl}/transactions`);
    url.searchParams.set('account_id', accountId);
    url.searchParams.set('start_date', startDate);
    url.searchParams.set('page', page.toString());

    logger.debug(`Fetching Aspire transactions page ${page} from: ${url.toString()}`);

    const response = await proxyFetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 60000,
      useProxyOn403: true // Use QuotaGuard proxy on IP restriction error
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Aspire API returned ${response.status}: ${errorText.substring(0, 200)}...`);
      throw new Error(`Aspire API error: ${response.status} - ${errorText.substring(0, 200)}`);
    }

    const data = await response.json() as AspireResponse;
    return data;
  }

  /**
   * Получает транзакции из Aspire Bank напрямую (без прокси)
   */
  async getTransactions(
    accountId: string,
    startDate: string,
    retries = 2
  ): Promise<AspireTransaction[]> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          logger.info(`Retry attempt ${attempt}/${retries} for Aspire account ${accountId}...`);
          // Wait before retry (exponential backoff)
          const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, etc.
          logger.info(`Waiting ${delay / 1000} seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        // Получаем первую страницу для получения метаданных
        const firstPage = await this.fetchPage(accountId, startDate, 1);
        logger.info(`✅ First page loaded, total transactions: ${firstPage.metadata?.total || firstPage.data.length}`);
        
        // Если есть только одна страница, возвращаем как есть
        if (!firstPage.metadata?.next_page_url) {
          logger.info('📄 Single page, returning as is');
          return firstPage.data || [];
        }

        // Собираем все страницы
        const allTransactions = [...(firstPage.data || [])];
        let currentPage = 2;
        const totalPages = firstPage.metadata?.total && firstPage.metadata?.per_page
          ? Math.ceil(firstPage.metadata.total / firstPage.metadata.per_page)
          : 1;

        logger.info(`📚 Fetching ${totalPages} pages total...`);

        while (currentPage <= totalPages) {
          try {
            logger.debug(`📄 Fetching page ${currentPage}/${totalPages}...`);
            const pageData = await this.fetchPage(accountId, startDate, currentPage);
            allTransactions.push(...(pageData.data || []));
            currentPage++;
            
            // Небольшая задержка между запросами
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (error: any) {
            logger.error(`❌ Error fetching page ${currentPage}:`, error.message);
            // Продолжаем с тем, что уже получили
            break;
          }
        }

        logger.info(`✅ Fetched ${allTransactions.length} transactions from Aspire account ${accountId}`);
        return allTransactions;
      } catch (error: any) {
        if (error.name === 'AbortError' || error.name === 'TimeoutError') {
          logger.error(`Request timeout after 60 seconds (attempt ${attempt + 1}/${retries + 1})`);
          if (attempt < retries) {
            continue;
          }
        }
        
        // Проверяем статус ошибки, если это HTTP ошибка
        if (error.message && error.message.includes('Aspire API error:')) {
          const statusMatch = error.message.match(/error: (\d+)/);
          if (statusMatch) {
            const status = parseInt(statusMatch[1]);
            if (status === 500 && attempt < retries) {
              logger.warn('Server error (500), will retry...');
              continue; // Retry on server error
            }
            
            if (status === 429 && attempt < retries) {
              logger.warn('Rate limit (429), will retry with longer delay...');
              await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second delay for rate limit
              continue;
            }
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

