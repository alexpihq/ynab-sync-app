import { logger } from '../utils/logger.js';
import { ynab } from '../clients/ynab.js';
import { zerion, ZerionParsedTransaction } from '../clients/zerion.js';
import { WALLET_MAPPINGS, ALLOWED_CHAINS, LEGIT_ASSETS, WalletMapping } from '../config/walletMapping.js';
import { SyncResult } from '../types/index.js';
import { convertUsdToEur } from './currency.js';
import crypto from 'crypto';

const SYNC_START_DATE = '2026-01-01';
const MIN_TRANSACTION_AMOUNT = 0.1; // Ignore transactions less than 0.1 USD (dust/spam filter)
const DELAY_BETWEEN_WALLETS = 2000; // 2 seconds delay between wallet syncs to avoid rate limiting

/**
 * Zerion Crypto Wallets Synchronization Service
 * 
 * Syncs cryptocurrency transactions from multiple wallets via Zerion API
 * to YNAB accounts across different budgets.
 * 
 * - Filters out transactions < 0.1 USD to avoid spam/dust
 * - Only syncs USDC and USDT stablecoins
 */
class ZerionSyncService {
  /**
   * Sync all configured crypto wallets
   */
  async syncAllWallets(): Promise<Record<string, SyncResult>> {
    logger.info('🔄 Starting Zerion wallets sync...');

    if (!zerion.isConfigured()) {
      logger.warn('⚠️  Zerion API key not configured, skipping sync');
      return {};
    }

    const results: Record<string, SyncResult> = {};

    for (const mapping of WALLET_MAPPINGS) {
      const walletLabel = `${mapping.description || mapping.walletAddress.substring(0, 10)}...`;
      logger.info(`\n📍 Processing wallet: ${walletLabel}`);

      try {
        const result = await this.syncWallet(mapping);
        results[mapping.walletAddress] = result;
        
        logger.info(
          `✅ ${walletLabel}: ` +
          `created=${result.created}, updated=${result.updated}, ` +
          `skipped=${result.skipped}, errors=${result.errors}`
        );
      } catch (error: any) {
        logger.error(`❌ Error syncing wallet ${walletLabel}:`, error.message);
        results[mapping.walletAddress] = {
          created: 0,
          updated: 0,
          skipped: 0,
          errors: 1,
          processed: 0,
          transactions: []
        };
      }

      // Add delay between wallet syncs to avoid rate limiting
      if (WALLET_MAPPINGS.indexOf(mapping) < WALLET_MAPPINGS.length - 1) {
        logger.debug(`⏸️  Waiting ${DELAY_BETWEEN_WALLETS}ms before next wallet...`);
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_WALLETS));
      }
    }

    logger.info('\n✅ Zerion wallets sync completed');
    return results;
  }

  /**
   * Sync a single wallet to its YNAB account
   */
  private async syncWallet(mapping: WalletMapping): Promise<SyncResult> {
    const { walletAddress, budgetId, accountId, budgetName, budgetCurrency } = mapping;

    // Fetch transactions from Zerion
    const zerionTxs = await zerion.getWalletTransactions(
      walletAddress,
      ALLOWED_CHAINS,
      LEGIT_ASSETS,
      SYNC_START_DATE
    );

    if (zerionTxs.length === 0) {
      logger.info(`ℹ️  No transactions found for wallet ${walletAddress.substring(0, 10)}...`);
      return {
        created: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        processed: 0,
        transactions: []
      };
    }

    // Fetch existing YNAB transactions for deduplication
    const existingTxs = await ynab.getAccountTransactions(budgetId, accountId, SYNC_START_DATE);
    const existingImportIds = new Set(
      existingTxs
        .map(tx => tx.import_id)
        .filter((id): id is string => !!id)
    );

    logger.info(
      `📊 Found ${zerionTxs.length} Zerion transactions, ` +
      `${existingImportIds.size} existing YNAB transactions`
    );

    let created = 0;
    let skipped = 0;
    let errors = 0;

    // Process each transaction
    for (const tx of zerionTxs) {
      try {
        const result = await this.processTransaction(
          tx,
          budgetId,
          accountId,
          existingImportIds,
          walletAddress,
          budgetCurrency
        );

        if (result === 'created') created++;
        else if (result === 'skipped') skipped++;
      } catch (error: any) {
        logger.error(`❌ Error processing transaction ${tx.hash}:`, error.message);
        errors++;
      }
    }

    return {
      created,
      updated: 0,
      skipped,
      errors,
      processed: zerionTxs.length,
      transactions: []
    };
  }

  /**
   * Process a single Zerion transaction
   */
  private async processTransaction(
    tx: ZerionParsedTransaction,
    budgetId: string,
    accountId: string,
    existingImportIds: Set<string>,
    walletAddress: string,
    budgetCurrency: 'USD' | 'EUR'
  ): Promise<'created' | 'skipped'> {
    // Generate import_id for deduplication
    // Keep original case for Solana addresses (case-sensitive), lowercase for EVM
    const normalizedAddress = walletAddress.startsWith('0x') 
      ? walletAddress.toLowerCase() 
      : walletAddress;
    
    // Create short unique import_id (max 36 chars for YNAB)
    // Use MD5 hash of wallet:hash combination to ensure uniqueness
    const fullId = `${normalizedAddress}:${tx.hash}`;
    const hash = crypto.createHash('md5').update(fullId).digest('hex');
    const importId = `ZERION:${hash.substring(0, 29)}`; // ZERION: (7) + 29 chars = 36 total

    // Check if already imported
    if (existingImportIds.has(importId)) {
      logger.debug(`⏭️  Skipping existing transaction: ${tx.hash.substring(0, 10)}...`);
      return 'skipped';
    }

    // Convert amount to YNAB milliunits
    const amountFloat = parseFloat(tx.amount);
    if (isNaN(amountFloat)) {
      logger.warn(`⚠️  Invalid amount for transaction ${tx.hash}: ${tx.amount}`);
      return 'skipped';
    }

    // Skip transactions less than minimum threshold (dust/spam filter)
    if (amountFloat < MIN_TRANSACTION_AMOUNT) {
      logger.debug(`⏭️  Skipping dust transaction: ${amountFloat} ${tx.asset} (< ${MIN_TRANSACTION_AMOUNT} USD)`);
      return 'skipped';
    }

    // Basic date validation (format already validated in zerion client)
    // Just check if date is not in the future
    const txDate = new Date(tx.date + 'T00:00:00Z');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (txDate > today) {
      logger.debug(`⏭️  Skipping future transaction ${tx.hash.substring(0, 20)}...: ${tx.date}`);
      return 'skipped';
    }

    // Convert amount to milliunits (USDC/USDT are in USD)
    const amountInUsdMilliunits = Math.round(amountFloat * 1000);

    // Convert to budget currency if needed (EUR for Alex Budget)
    let ynabAmount: number;
    
    if (budgetCurrency === 'EUR') {
      // Convert USD to EUR using Supabase exchange rates
      const convertedAmount = await convertUsdToEur(amountInUsdMilliunits, tx.date);
      
      if (convertedAmount === null) {
        logger.warn(`⚠️  Cannot convert USD to EUR for transaction ${tx.hash.substring(0, 20)}... (missing exchange rate for ${tx.date.substring(0, 7)})`);
        return 'skipped';
      }
      
      ynabAmount = tx.type === 'receive' ? convertedAmount : -convertedAmount;
    } else {
      // Budget is in USD, no conversion needed
      ynabAmount = tx.type === 'receive' ? amountInUsdMilliunits : -amountInUsdMilliunits;
    }

    // Build memo
    const walletShort = walletAddress.substring(0, 6) + '...' + walletAddress.substring(walletAddress.length - 4);
    const counterparty = tx.type === 'receive' 
      ? tx.sender.substring(0, 10) + '...'
      : tx.recipient.substring(0, 10) + '...';
    
    const memo = `${tx.asset} ${tx.type} via ${tx.chain} | ${counterparty} | ${walletShort} | ${tx.hash.substring(0, 10)}...`;

    // Payee name
    const payeeName = tx.type === 'receive'
      ? `Crypto ${tx.type} from ${tx.sender.substring(0, 10)}...`
      : `Crypto ${tx.type} to ${tx.recipient.substring(0, 10)}...`;

    // Debug logging before YNAB API call
    logger.info(`📤 Sending to YNAB: date="${tx.date}" (type: ${typeof tx.date}, length: ${tx.date.length}), amount=${ynabAmount}, hash=${tx.hash.substring(0, 10)}...`);
    
    // Create transaction in YNAB
    await ynab.createTransaction(budgetId, {
      account_id: accountId,
      date: tx.date,
      amount: ynabAmount,
      payee_name: payeeName,
      memo: memo.substring(0, 500), // YNAB limit
      cleared: 'cleared',
      approved: false, // Requires manual approval in YNAB
      import_id: importId
    });

    logger.debug(
      `✅ Created: ${tx.date} | ${tx.asset} ${tx.amount} | ${tx.type} | ${tx.hash.substring(0, 10)}...`
    );

    return 'created';
  }
}

export const zerionSyncService = new ZerionSyncService();

