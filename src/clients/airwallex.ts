import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export interface AirwallexTransaction {
  id: string;
  batch_id: string | null;
  source_id: string;
  funding_source_id: string | null;
  source_type: string;
  transaction_type: string;
  currency: string;
  amount: number;
  client_rate: number | null;
  currency_pair: string | null;
  net: number;
  fee: number;
  estimated_settled_at: string | null;
  settled_at: string | null;
  description: string | null;
  status: string;
  created_at: string;
}

interface AirwallexResponse {
  has_more: boolean;
  items: AirwallexTransaction[];
}

interface TokenCache {
  token: string | null;
  expires_at: number | null;
}

class AirwallexService {
  private tokenCache: TokenCache = {
    token: null,
    expires_at: null,
  };
  private readonly apiBaseUrl = 'https://api.airwallex.com/api/v1';

  constructor() {
    if (this.isConfigured()) {
      logger.info('Airwallex client initialized');
    }
  }

  isConfigured(): boolean {
    return !!(config.airwallexApiKey && config.airwallexClientId);
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache.token && this.tokenCache.expires_at && Date.now() < this.tokenCache.expires_at) {
      logger.debug('Using cached Airwallex access token');
      return this.tokenCache.token;
    }

    try {
      logger.info('Getting new Airwallex access token...');

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': config.airwallexApiKey,
        'x-client-id': config.airwallexClientId,
      };

      if (config.airwallexAccountId) {
        headers['x-login-as'] = config.airwallexAccountId;
      }

      const response = await fetch(`${this.apiBaseUrl}/authentication/login`, {
        method: 'POST',
        headers,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Airwallex auth failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as { token: string; expires_at: string };

      const expiresAt = new Date(data.expires_at).getTime();
      this.tokenCache = {
        token: data.token,
        expires_at: expiresAt - 60000, // 1 minute safety margin
      };

      const ttlSeconds = Math.round((expiresAt - Date.now()) / 1000);
      logger.info(`Airwallex token cached, expires in ${ttlSeconds}s`);
      return data.token;
    } catch (error: any) {
      logger.error('Airwallex Token Error:', error.message);
      throw error;
    }
  }

  async getFinancialTransactions(
    currency: string,
    fromDate: string,
    pageSize = 200,
  ): Promise<AirwallexTransaction[]> {
    const allTransactions: AirwallexTransaction[] = [];
    let pageNum = 0;
    let hasMore = true;

    while (hasMore) {
      const token = await this.getAccessToken();

      const url = new URL(`${this.apiBaseUrl}/financial_transactions`);
      url.searchParams.set('currency', currency);
      url.searchParams.set('from_created_at', fromDate);
      url.searchParams.set('page_num', pageNum.toString());
      url.searchParams.set('page_size', pageSize.toString());

      logger.debug(`Fetching Airwallex transactions page ${pageNum}: ${url.toString()}`);

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Airwallex API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as AirwallexResponse;
      allTransactions.push(...data.items);
      hasMore = data.has_more;
      pageNum++;

      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    logger.info(`Fetched ${allTransactions.length} Airwallex ${currency} transactions`);
    return allTransactions;
  }

  /**
   * Convert Airwallex amount (whole units like 10000.00) to YNAB milliunits (10000000)
   */
  convertToMilliunits(amount: number): number {
    return Math.round(amount * 1000);
  }

  /**
   * Normalize Airwallex datetime to YYYY-MM-DD for YNAB
   */
  normalizeDate(datetime: string): string {
    return datetime.split('T')[0];
  }

  /**
   * Generate unique import_id for YNAB (max 36 chars)
   * Format: AWX:<first 30 chars of transaction id>
   */
  generateImportId(transaction: AirwallexTransaction): string {
    const txId = transaction.id.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 30);
    return `AWX:${txId}`;
  }
}

export const airwallex = new AirwallexService();
