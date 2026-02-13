import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

interface ZerionTransfer {
  fungible_info?: {
    symbol?: string;
    flags?: {
      verified?: boolean;
    };
    implementations?: Array<{
      chain_id?: string;
      address?: string;
      decimals?: number;
    }>;
  };
  nft_info?: {
    name?: string;
    flags?: {
      is_spam?: boolean;
    };
  };
  quantity?: {
    numeric?: string;
  };
  sender?: string;
  recipient?: string;
}

interface ZerionTransaction {
  id: string;
  attributes: {
    operation_type?: string;
    mined_at?: string;
    submitted_at?: string;
    hash?: string;
    transfers?: ZerionTransfer[];
  };
  relationships?: {
    chain?: {
      data?: {
        id?: string;
      };
    };
  };
}

interface ZerionResponse {
  data: ZerionTransaction[];
  links?: {
    next?: string;
  };
}

export interface ZerionParsedTransaction {
  hash: string;
  date: string; // YYYY-MM-DD
  type: 'send' | 'receive';
  asset: string;
  amount: string;
  sender: string;
  recipient: string;
  chain: string;
}

class ZerionClient {
  private apiKey: string;
  private baseUrl = 'https://api.zerion.io/v1';

  constructor() {
    this.apiKey = config.zerionApiKey;
    if (!this.apiKey) {
      throw new Error('ZERION_API_KEY not configured');
    }
    logger.info('Zerion API client initialized');
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  private normalizeTokenSymbol(symbol: string): string {
    if (!symbol) return '';
    return symbol
      .normalize('NFKD')
      .replace(/[^\x00-\x7F]/g, '')
      .toUpperCase()
      .trim();
  }

  /**
   * Fetch all transactions for a wallet address with pagination
   */
  async getWalletTransactions(
    walletAddress: string,
    allowedChains: string[],
    legitimateAssets: string[],
    startDate: string // YYYY-MM-DD
  ): Promise<ZerionParsedTransaction[]> {
    logger.info(`📥 Fetching Zerion transactions for wallet ${walletAddress.substring(0, 10)}...`);

    const transactions: ZerionParsedTransaction[] = [];
    const seenHashes = new Set<string>();
    
    // Normalize address: EVM addresses (0x...) to lowercase, Solana addresses keep original case
    const normalizedAddress = walletAddress.startsWith('0x') 
      ? walletAddress.toLowerCase() 
      : walletAddress;
    
    let nextUrl: string | null = `${this.baseUrl}/wallets/${normalizedAddress}/transactions`;
    const startDateTime = new Date(startDate + 'T00:00:00Z').getTime();

    const headers = {
      'Authorization': 'Basic ' + Buffer.from(this.apiKey + ':').toString('base64'),
      'Accept': 'application/json'
    };

    let pageCount = 0;
    const maxPages = 100; // Safety limit

    while (nextUrl && pageCount < maxPages) {
      pageCount++;

      try {
        const response = await fetch(nextUrl, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(30000)
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error(`Zerion API error ${response.status}: ${errorText.substring(0, 200)}`);
          throw new Error(`Zerion API error: ${response.status}`);
        }

        const data = await response.json() as ZerionResponse;
        const txList = Array.isArray(data.data) ? data.data : [];

        logger.debug(`📄 Page ${pageCount}: ${txList.length} transactions`);

        for (const tx of txList) {
          const attrs = tx.attributes;
          const type = attrs.operation_type;

          // Only process send/receive
          if (!['send', 'receive'].includes(type || '')) continue;

          // Check chain
          const chainId = tx.relationships?.chain?.data?.id || '';
          if (!allowedChains.includes(chainId)) continue;

          // Parse date
          const rawDate = attrs.mined_at || attrs.submitted_at || '';
          if (!rawDate) continue;

          // Extract date in YYYY-MM-DD format (more reliable than toISOString for timezone handling)
          // Zerion returns ISO 8601 format: "2026-01-07T19:10:21Z"
          const dateString = rawDate.split('T')[0];
          
          // Validate date format
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
            logger.warn(`⚠️  Invalid date format from Zerion: ${rawDate}`);
            continue;
          }

          // Check if transaction is after start date
          const txDate = new Date(dateString + 'T00:00:00Z');
          const txDateTime = txDate.getTime();

          if (txDateTime < startDateTime) {
            logger.debug(`⏭️  Reached transactions before ${startDate}, stopping pagination`);
            nextUrl = null;
            break;
          }

          // Process transfers
          const transfers = attrs.transfers || [];
          if (transfers.length === 0) continue;

          // Find valid transfer
          let validTransfer: (ZerionTransfer & { asset: string }) | null = null;

          for (const tr of transfers) {
            const rawAsset = tr.fungible_info?.symbol || '';
            const asset = this.normalizeTokenSymbol(rawAsset);
            const isSpam = tr.nft_info?.flags?.is_spam || false;
            const isVerified = tr.fungible_info?.flags?.verified === true;

            // Only allow legitimate assets
            if (!legitimateAssets.includes(asset)) continue;
            if (isSpam) continue;

            // Reject unverified tokens (address poisoning protection)
            if (!isVerified) {
              logger.warn(`⚠️  Skipping unverified token "${rawAsset}" in tx ${(attrs.hash || '').substring(0, 16)}... (possible address poisoning)`);
              continue;
            }

            validTransfer = { ...tr, asset };
            break;
          }

          if (!validTransfer) continue;

          const amount = validTransfer.quantity?.numeric || '0';
          const sender = validTransfer.sender || '';
          const recipient = validTransfer.recipient || '';
          const hash = attrs.hash || '';

          // Deduplicate by hash
          if (seenHashes.has(hash)) {
            logger.debug(`⛔️ Skipping duplicate hash: ${hash}`);
            continue;
          }
          seenHashes.add(hash);

          transactions.push({
            hash,
            date: dateString,
            type: type as 'send' | 'receive',
            asset: validTransfer.asset,
            amount,
            sender,
            recipient,
            chain: chainId
          });
        }

        // Get next page URL
        nextUrl = data.links?.next || null;

        // Delay between pages to avoid rate limiting
        if (nextUrl) {
          await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
        }

      } catch (error: any) {
        if (error.name === 'AbortError' || error.name === 'TimeoutError') {
          logger.error(`Request timeout for wallet ${walletAddress}`);
        }
        throw error;
      }
    }

    logger.info(`✅ Fetched ${transactions.length} valid transactions for wallet ${walletAddress.substring(0, 10)}...`);
    return transactions;
  }
}

export const zerion = new ZerionClient();

