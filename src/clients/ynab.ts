import { config, YNAB_API_BASE } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { YnabTransactionDetail, YnabTransactionsResponse } from '../types/index.js';

interface CreateTransactionRequest {
  account_id: string;
  date: string; // YYYY-MM-DD
  amount: number; // milliunits
  payee_name?: string;
  memo?: string;
  cleared?: 'cleared' | 'uncleared' | 'reconciled';
  approved?: boolean;
  import_id?: string;
}

class YnabService {
  private token: string;
  private baseUrl: string;

  constructor() {
    this.token = config.ynabToken;
    this.baseUrl = YNAB_API_BASE;
    logger.info('YNAB client initialized');
  }

  private async fetch<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`YNAB API error [${response.status}]:`, errorText);
      throw new Error(`YNAB API error: ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  // ===== Get Transactions =====
  async getTransactions(
    budgetId: string,
    sinceDate?: string,
    lastKnowledge?: number
  ): Promise<{ transactions: YnabTransactionDetail[]; serverKnowledge: number }> {
    let endpoint = `/budgets/${budgetId}/transactions`;
    const params = new URLSearchParams();

    if (sinceDate) {
      params.append('since_date', sinceDate);
    }

    if (lastKnowledge) {
      params.append('last_knowledge_of_server', lastKnowledge.toString());
    }

    if (params.toString()) {
      endpoint += `?${params.toString()}`;
    }

    const response = await this.fetch<YnabTransactionsResponse>(endpoint);
    
    return {
      transactions: response.data.transactions,
      serverKnowledge: response.data.server_knowledge,
    };
  }

  // ===== Get Account Transactions =====
  async getAccountTransactions(
    budgetId: string,
    accountId: string,
    sinceDate?: string
  ): Promise<YnabTransactionDetail[]> {
    let endpoint = `/budgets/${budgetId}/accounts/${accountId}/transactions`;
    
    if (sinceDate) {
      endpoint += `?since_date=${sinceDate}`;
    }

    const response = await this.fetch<YnabTransactionsResponse>(endpoint);
    return response.data.transactions;
  }

  // ===== Create Transaction =====
  async createTransaction(
    budgetId: string,
    transaction: CreateTransactionRequest
  ): Promise<YnabTransactionDetail> {
    const response = await this.fetch<{ data: { transaction: YnabTransactionDetail } }>(
      `/budgets/${budgetId}/transactions`,
      {
        method: 'POST',
        body: JSON.stringify({ transaction }),
      }
    );

    logger.info(`Created transaction in budget ${budgetId}:`, {
      id: response.data.transaction.id,
      amount: response.data.transaction.amount,
      date: response.data.transaction.date,
    });

    return response.data.transaction;
  }

  // ===== Update Transaction =====
  async updateTransaction(
    budgetId: string,
    transactionId: string,
    updates: Partial<CreateTransactionRequest>
  ): Promise<YnabTransactionDetail | null> {
    try {
      const response = await this.fetch<{ data: { transaction: YnabTransactionDetail } }>(
        `/budgets/${budgetId}/transactions/${transactionId}`,
        {
          method: 'PUT',
          body: JSON.stringify({ transaction: updates }),
        }
      );

      logger.info(`Updated transaction ${transactionId} in budget ${budgetId}`);
      return response.data.transaction;
    } catch (error) {
      logger.error('Error updating transaction:', error);
      return null;
    }
  }

  // ===== Delete Transaction =====
  async deleteTransaction(
    budgetId: string,
    transactionId: string
  ): Promise<boolean> {
    try {
      await this.fetch(
        `/budgets/${budgetId}/transactions/${transactionId}`,
        { method: 'DELETE' }
      );

      logger.info(`Deleted transaction ${transactionId} from budget ${budgetId}`);
      return true;
    } catch (error: any) {
      // Если транзакция не найдена (404 или 500) - считаем что она уже удалена
      if (error.message?.includes('404') || error.message?.includes('500')) {
        logger.debug(`Transaction ${transactionId} already deleted or not found`);
        return true;
      }
      logger.error('Error deleting transaction:', error);
      return false;
    }
  }

  // ===== Get Single Transaction =====
  async getTransaction(
    budgetId: string,
    transactionId: string
  ): Promise<YnabTransactionDetail | null> {
    try {
      const response = await this.fetch<{ data: { transaction: YnabTransactionDetail } }>(
        `/budgets/${budgetId}/transactions/${transactionId}`
      );

      return response.data.transaction;
    } catch (error) {
      logger.error('Error fetching transaction:', error);
      return null;
    }
  }
}

export const ynab = new YnabService();

