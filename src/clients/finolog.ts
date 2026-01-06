import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Finolog API Client
 * Documentation: https://api.finolog.ru/docs
 */

const FINOLOG_API_BASE = 'https://api.finolog.ru/v1';

export interface FinologTransaction {
  id: number;
  date: string; // "YYYY-MM-DD HH:MM:SS"
  type: 'income' | 'expense' | 'in' | 'out'; // income/in = доход, expense/out = расход
  description: string | null;
  value: number; // Amount as float (10.00 EUR = 10.00, 1000 RUB = 1000.00)
  contractor_id: number | null;
  transfer_id: number | null;
  account_id: number;
  // Add other fields as needed
}

export interface FinologAccount {
  id: number;
  name: string;
  currency: string; // 'EUR', 'USD', 'RUB'
}

export interface FinologSyncConfig {
  bizId: number;
  accountId: number;
  currency: 'EUR' | 'USD' | 'RUB';
}

class FinologClient {
  private token: string;

  constructor() {
    this.token = config.finologApiToken;
    if (!this.token) {
      logger.warn('Finolog API token not configured - Finolog sync will be disabled');
    } else {
      logger.info('Finolog client initialized');
    }
  }

  /**
   * Проверяет, настроен ли Finolog клиент
   */
  isConfigured(): boolean {
    return !!this.token;
  }

  /**
   * Выполняет запрос к Finolog API
   */
  private async fetch<T>(endpoint: string): Promise<T> {
    const url = `${FINOLOG_API_BASE}${endpoint}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': '*/*',
          'Api-Token': this.token,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`Finolog API error [${response.status}]:`, errorText);
        throw new Error(`Finolog API error: ${response.status} - ${errorText}`);
      }

      return response.json() as Promise<T>;
    } catch (error: any) {
      logger.error('Error fetching from Finolog:', error.message);
      throw error;
    }
  }

  /**
   * Получает транзакции из Finolog для указанного аккаунта
   */
  async getTransactions(
    bizId: number,
    accountId: number,
    fromDate: string, // YYYY-MM-DD
    toDate: string // YYYY-MM-DD
  ): Promise<FinologTransaction[]> {
    const params = new URLSearchParams({
      status: 'regular',
      account_ids: accountId.toString(),
      report_date_from: fromDate,
      report_date_to: toDate,
      with_transfer: 'true',
      with_bizzed: 'false',
      with_splitted: 'false',
      without_closed_accounts: 'false',
    });

    const endpoint = `/biz/${bizId}/transaction?${params.toString()}`;
    
    logger.debug(`Fetching Finolog transactions: bizId=${bizId}, accountId=${accountId}, from=${fromDate}`);
    
    const transactions = await this.fetch<FinologTransaction[]>(endpoint);
    
    logger.info(`Fetched ${transactions.length} transactions from Finolog account ${accountId}`);
    
    return transactions;
  }

  /**
   * Нормализует дату из Finolog формата в YNAB формат
   */
  normalizeDate(finologDate: string): string {
    // Finolog: "2026-01-15 12:34:56"
    // YNAB: "2026-01-15"
    return finologDate.split(' ')[0];
  }

  /**
   * Конвертирует сумму из Finolog в YNAB milliunits
   * Finolog API возвращает value как число с плавающей точкой: 10.00
   * YNAB хранит в milliunits: 10.00 EUR = 10000 milliunits
   */
  convertToMilliunits(finologValue: number): number {
    // Finolog: 10.00 (float)
    // YNAB: 10000 (milliunits)
    // Умножаем на 1000
    return Math.round(finologValue * 1000);
  }

  /**
   * Формирует уникальный import_id для транзакции Finolog
   */
  generateImportId(transaction: FinologTransaction, accountId: number): string {
    // Формат: FINOLOG:accountId:transactionId
    // Пример: FINOLOG:161752:12345
    return `FINOLOG:${accountId}:${transaction.id}`;
  }
}

export const finolog = new FinologClient();

