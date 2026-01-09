import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger.js';

export interface ZenmoneyAccount {
  id: string;
  changed: number;
  user: number;
  role: number | null;
  instrument: number;
  company: number | null;
  type: string;
  title: string;
  syncID: string[] | null;
  balance: number;
  startBalance: number;
  creditLimit: number;
  inBalance: boolean;
  savings: boolean | null;
  enableCorrection: boolean;
  enableSMS: boolean;
  archive: boolean;
  private: boolean;
  // capitalization: boolean | null;
  // percent: number | null;
  // startDate: string | null;
  // endDateOffset: number | null;
  // endDateOffsetInterval: string | null;
  // payoffStep: number | null;
  // payoffInterval: string | null;
}

export interface ZenmoneyTransaction {
  id: string;
  changed: number;
  created: number;
  user: number;
  deleted: boolean;
  hold: boolean | null;
  viewed: boolean | null;
  qrCode: string | null;
  incomeBankID: string | null;
  outcomeBankID: string | null;
  incomeInstrument: number;
  incomeAccount: string;
  income: number;
  outcomeInstrument: number;
  outcomeAccount: string;
  outcome: number;
  tag: string[] | null;
  merchant: string | null;
  payee: string | null;
  originalPayee: string | null;
  comment: string | null;
  date: string;
  mcc: number | null;
  reminderMarker: string | null;
  opIncome: number | null;
  opIncomeInstrument: number | null;
  opOutcome: number | null;
  opOutcomeInstrument: number | null;
  latitude: number | null;
  longitude: number | null;
}

export interface ZenmoneyInstrument {
  id: number;
  changed: number;
  title: string;
  shortTitle: string;
  symbol: string;
  rate: number;
}

export interface ZenmoneyDiffRequest {
  serverTimestamp: number;
  currentClientTimestamp: number;
  forceFetch?: string[];
}

export interface ZenmoneyDiffResponse {
  serverTimestamp: number;
  deletion?: Array<{
    id: string;
    object: string;
    user: number;
    stamp: number;
  }>;
  instrument?: ZenmoneyInstrument[];
  account?: ZenmoneyAccount[];
  transaction?: ZenmoneyTransaction[];
  tag?: Array<{
    id: string;
    changed: number;
    user: number;
    title: string;
    parent: string | null;
    icon: string | null;
    picture: string | null;
    color: number | null;
    showIncome: boolean;
    showOutcome: boolean;
    budgetIncome: boolean;
    budgetOutcome: boolean;
    required: boolean | null;
  }>;
  merchant?: Array<{
    id: string;
    changed: number;
    user: number;
    title: string;
  }>;
}

export class ZenmoneyClient {
  private client: AxiosInstance;
  private token: string;

  constructor(token: string) {
    this.token = token;
    this.client = axios.create({
      baseURL: 'https://api.zenmoney.ru',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    logger.info('Zenmoney client initialized');
  }

  /**
   * Fetch data diff from Zenmoney
   */
  async getDiff(request: ZenmoneyDiffRequest): Promise<ZenmoneyDiffResponse> {
    try {
      logger.debug('Fetching Zenmoney diff', { request });

      const response = await this.client.post<ZenmoneyDiffResponse>('/v8/diff/', request);

      logger.debug('Zenmoney diff response', {
        serverTimestamp: response.data.serverTimestamp,
        accountCount: response.data.account?.length || 0,
        transactionCount: response.data.transaction?.length || 0,
      });

      return response.data;
    } catch (error: any) {
      logger.error('Error fetching Zenmoney diff:', error.response?.data || error.message);
      throw new Error(`Failed to fetch Zenmoney diff: ${error.message}`);
    }
  }

  /**
   * Get all data since January 1, 2026
   */
  async getAllDataSince2026(): Promise<ZenmoneyDiffResponse> {
    const jan2026Timestamp = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
    
    return this.getDiff({
      serverTimestamp: jan2026Timestamp,
      currentClientTimestamp: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * Get transactions for specific accounts since a date
   */
  async getTransactionsSince(
    accountIds: string[],
    sinceDate: Date
  ): Promise<ZenmoneyTransaction[]> {
    // Get all data (serverTimestamp=0 means get everything)
    const data = await this.getDiff({
      serverTimestamp: 0,
      currentClientTimestamp: Math.floor(Date.now() / 1000),
    });

    if (!data.transaction) {
      return [];
    }

    // Format sinceDate as YYYY-MM-DD for comparison
    const sinceDateStr = sinceDate.toISOString().split('T')[0];

    // Filter transactions by account and date
    return data.transaction.filter(tx => 
      !tx.deleted && 
      tx.date >= sinceDateStr && // Only transactions on or after sinceDate
      (
        accountIds.includes(tx.incomeAccount) || 
        accountIds.includes(tx.outcomeAccount)
      )
    );
  }

  /**
   * Get account information
   */
  async getAccounts(): Promise<ZenmoneyAccount[]> {
    const data = await this.getDiff({
      serverTimestamp: 0,
      currentClientTimestamp: Math.floor(Date.now() / 1000),
    });

    return data.account || [];
  }
}

