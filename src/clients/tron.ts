import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export interface TronTransaction {
  transaction_id: string;
  block_ts: number; // Unix timestamp in milliseconds
  from_address: string;
  to_address: string;
  quant: string; // Amount in smallest unit (divide by 1e6 for USDT)
  tokenInfo?: {
    tokenAbbr: string; // Should be 'USDT'
  };
}

export interface TronApiResponse {
  token_transfers: TronTransaction[];
  rangeTotal?: number;
}

class TronService {
  private walletAddress: string;
  private apiKey: string;
  private baseUrl = 'https://apilist.tronscanapi.com/api';

  constructor() {
    this.walletAddress = config.tronWalletAddress;
    this.apiKey = config.tronApiKey;
    if (this.walletAddress && this.apiKey) {
      logger.info('Tron client initialized');
    }
  }

  /**
   * Проверяет, настроен ли Tron клиент
   */
  isConfigured(): boolean {
    return !!this.walletAddress && !!this.apiKey;
  }

  /**
   * Получает USDT транзакции из Tron blockchain
   */
  async getUsdtTransactions(
    startDate: string, // YYYY-MM-DD
    direction: 'in' | 'out'
  ): Promise<TronTransaction[]> {
    const startTimestamp = new Date(startDate).getTime();
    const transactions: TronTransaction[] = [];
    const pageSize = 50;
    let start = 0;
    let hasMore = true;

    while (hasMore) {
      const queryParam = direction === 'in' 
        ? `toAddress=${this.walletAddress}` 
        : `fromAddress=${this.walletAddress}`;
      
      const url = `${this.baseUrl}/token_trc20/transfers?limit=${pageSize}&start=${start}&sort=-timestamp&${queryParam}`;

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'TRON-PRO-API-KEY': this.apiKey,
          }
        });

        if (response.status === 429) {
          logger.warn('Tron API rate limit (429), waiting 30 seconds...');
          await new Promise(resolve => setTimeout(resolve, 30000));
          continue; // Retry the same request
        }

        if (!response.ok) {
          throw new Error(`Tron API error: ${response.status} - ${await response.text()}`);
        }

        const data = await response.json() as TronApiResponse;
        const txs = data.token_transfers || [];

        if (txs.length === 0) {
          hasMore = false;
          break;
        }

        for (const tx of txs) {
          // Проверяем дату
          if (tx.block_ts < startTimestamp) {
            hasMore = false;
            break;
          }

          // Только USDT
          const token = tx.tokenInfo?.tokenAbbr || 'UNKNOWN';
          if (token !== 'USDT') {
            continue;
          }

          transactions.push(tx);
        }

        start += pageSize;

        // Rate limiting: минимум 1.2 секунды между запросами
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 1200));
        }

      } catch (error: any) {
        logger.error(`Error fetching Tron transactions (${direction}):`, error.message);
        throw error;
      }
    }

    logger.debug(`Fetched ${transactions.length} USDT transactions (${direction}) from Tron blockchain`);
    return transactions;
  }

  /**
   * Конвертирует сумму из Tron (quant) в YNAB milliunits
   * Tron USDT: quant / 1e6 = USD
   * YNAB: 1000 = 1.00 USD
   */
  convertToMilliunits(quantString: string, direction: 'in' | 'out'): number {
    const usdAmount = parseFloat(quantString) / 1e6;
    const milliunits = Math.round(usdAmount * 1000);
    // Для исходящих транзакций делаем отрицательными
    return direction === 'out' ? -milliunits : milliunits;
  }

  /**
   * Нормализует дату из Tron timestamp в YYYY-MM-DD для YNAB
   */
  normalizeDate(blockTs: number): string {
    const date = new Date(blockTs);
    return date.toISOString().split('T')[0];
  }

  /**
   * Генерирует уникальный import_id для YNAB (макс 36 символов)
   * Tron transaction_id - это 64-символьный hex hash
   */
  generateImportId(transactionId: string): string {
    // TRON: + первые 28 символов txid = 33 символа
    return `TRON:${transactionId.substring(0, 28)}`;
  }

  /**
   * Форматирует адрес для Payee (сокращает)
   */
  formatAddress(address: string): string {
    // Показываем первые 6 и последние 4 символа
    if (address.length <= 10) return address;
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
  }
}

export const tron = new TronService();




