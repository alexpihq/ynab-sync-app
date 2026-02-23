import { ethers } from 'ethers';
import { SiweMessage } from 'siwe';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const API_BASE = 'https://api.gnosispay.com/api/v1';
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; YNABSync/1.0)',
};

export interface GnosisPayTransaction {
  createdAt: string;
  clearedAt: string | null;
  isPending: boolean;
  kind: 'Payment' | 'Refund' | 'Reversal';
  status: string;
  merchant: {
    name: string;
    city?: string;
    country?: { name?: string; alpha2?: string };
  };
  billingAmount: string;
  billingCurrency: {
    symbol: string;
    code: string;
    decimals: number;
    name: string;
  };
  transactionAmount: string;
  transactionCurrency: {
    symbol: string;
    code: string;
    decimals: number;
    name: string;
  };
  cardToken: string;
  transactions?: Array<{
    hash?: string;
    status?: string;
  }>;
}

interface GnosisPayListResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: GnosisPayTransaction[];
}

class GnosisPayClient {
  private privateKey: string;
  private wallet: ethers.Wallet | null = null;
  private token: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor() {
    this.privateKey = config.gnosispayPrivateKey;
  }

  isConfigured(): boolean {
    return !!this.privateKey;
  }

  private getWallet(): ethers.Wallet {
    if (!this.wallet) {
      const key = this.privateKey.startsWith('0x') ? this.privateKey : `0x${this.privateKey}`;
      this.wallet = new ethers.Wallet(key);
    }
    return this.wallet;
  }

  private async authenticate(): Promise<string> {
    // Reuse token if still valid (with 5 min buffer)
    if (this.token && Date.now() < this.tokenExpiresAt - 300_000) {
      return this.token;
    }

    const wallet = this.getWallet();
    logger.info(`🔑 GnosisPay: authenticating as ${wallet.address}...`);

    // Step 1: Get nonce
    const nonceResp = await fetch(`${API_BASE}/auth/nonce`, {
      headers: DEFAULT_HEADERS,
    });
    if (!nonceResp.ok) {
      throw new Error(`GnosisPay nonce error: ${nonceResp.status}`);
    }
    const nonceText = await nonceResp.text();
    const nonce = nonceText.trim().replace(/^"|"$/g, '');

    // Step 2: Create and sign SIWE message
    const now = new Date();
    const siweMessage = new SiweMessage({
      domain: 'api.gnosispay.com',
      address: wallet.address,
      uri: 'https://api.gnosispay.com',
      version: '1',
      chainId: 100, // Gnosis Chain
      nonce,
      issuedAt: now.toISOString(),
    });

    const messageStr = siweMessage.prepareMessage();
    const signature = await wallet.signMessage(messageStr);

    // Step 3: Verify and get JWT
    const ttlInSeconds = 3600;
    const challengeResp = await fetch(`${API_BASE}/auth/challenge`, {
      method: 'POST',
      headers: { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: messageStr,
        signature,
        ttlInSeconds,
      }),
    });

    if (!challengeResp.ok) {
      const errText = await challengeResp.text();
      throw new Error(`GnosisPay auth error: ${challengeResp.status} - ${errText}`);
    }

    const { token } = await challengeResp.json() as { token: string };
    this.token = token;
    this.tokenExpiresAt = Date.now() + ttlInSeconds * 1000;

    logger.info('✅ GnosisPay: authenticated successfully');
    return token;
  }

  /**
   * Fetch card transactions with pagination
   */
  async getTransactions(afterDate: string): Promise<GnosisPayTransaction[]> {
    const token = await this.authenticate();
    const allTransactions: GnosisPayTransaction[] = [];

    let offset = 0;
    const limit = 100;
    const afterISO = `${afterDate}T00:00:00Z`;

    while (true) {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        after: afterISO,
      });

      const resp = await fetch(`${API_BASE}/cards/transactions?${params}`, {
        headers: { ...DEFAULT_HEADERS, Authorization: `Bearer ${token}` },
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`GnosisPay transactions error: ${resp.status} - ${errText}`);
      }

      const data = await resp.json() as GnosisPayListResponse;
      allTransactions.push(...data.results);

      logger.debug(`📄 GnosisPay: fetched ${data.results.length} transactions (offset ${offset})`);

      if (!data.next || data.results.length < limit) {
        break;
      }

      offset += limit;

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    logger.info(`✅ GnosisPay: fetched ${allTransactions.length} transactions since ${afterDate}`);
    return allTransactions;
  }

  /**
   * Generate a unique, stable ID for a transaction.
   * Uses onchain tx hash if available, otherwise timestamp + merchant + amount.
   */
  generateTransactionId(tx: GnosisPayTransaction): string {
    const onchainHash = tx.transactions?.[0]?.hash;
    if (onchainHash) {
      return onchainHash;
    }
    // Fallback: combine date + merchant + amount for a stable identifier
    return `${tx.createdAt}|${tx.merchant.name}|${tx.billingAmount}`;
  }
}

export const gnosispay = new GnosisPayClient();
