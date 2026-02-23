import { logger } from '../utils/logger.js';
import { ynab } from '../clients/ynab.js';
import { gnosispay, GnosisPayTransaction } from '../clients/gnosispay.js';
import crypto from 'crypto';

// Target YNAB account for GnosisPay
const GNOSIS_PAY_BUDGET_ID = '90024622-dd15-4ef9-bfad-4e555f5471ac';
const GNOSIS_PAY_ACCOUNT_ID = 'c191bb72-1b7f-4976-98e5-f335befe48e4';

const SYNC_START_DATE = '2026-01-01';

interface GnosisPaySyncResult {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  processed: number;
}

/**
 * GnosisPay → YNAB Sync Service
 *
 * Syncs card transactions from GnosisPay to YNAB Personal budget.
 * Amounts are in EUR (billingAmount in cents → YNAB milliunits).
 * No currency conversion needed.
 */
export async function syncGnosispayToYnab(): Promise<GnosisPaySyncResult> {
  if (!gnosispay.isConfigured()) {
    logger.info('💳 GnosisPay not configured (GNOSISPAY_PRIVATE_KEY missing), skipping');
    return { created: 0, updated: 0, skipped: 0, errors: 0, processed: 0 };
  }

  logger.info('💳 Starting GnosisPay → YNAB sync...');

  try {
    // 1. Fetch transactions from GnosisPay
    const gpTransactions = await gnosispay.getTransactions(SYNC_START_DATE);

    if (gpTransactions.length === 0) {
      logger.info('ℹ️  No GnosisPay transactions found');
      return { created: 0, updated: 0, skipped: 0, errors: 0, processed: 0 };
    }

    // 2. Fetch existing YNAB transactions for deduplication
    const existingTxs = await ynab.getAccountTransactions(
      GNOSIS_PAY_BUDGET_ID,
      GNOSIS_PAY_ACCOUNT_ID,
      SYNC_START_DATE
    );
    const existingImportIds = new Set(
      existingTxs
        .map(tx => tx.import_id)
        .filter((id): id is string => !!id)
    );

    logger.info(
      `📊 GnosisPay: ${gpTransactions.length} transactions to process, ` +
      `${existingImportIds.size} already in YNAB`
    );

    let created = 0;
    let skipped = 0;
    let errors = 0;

    // 3. Process each transaction (with rate limit delay)
    for (const tx of gpTransactions) {
      try {
        const result = await processTransaction(tx, existingImportIds);
        if (result === 'created') {
          created++;
          // Small delay to avoid YNAB rate limits (200 req/hour)
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        else if (result === 'skipped') skipped++;
      } catch (error: any) {
        if (error.message?.includes('409')) {
          logger.info(`⏭️ GnosisPay transaction already exists (409), skipping`);
          skipped++;
        } else {
          logger.error(`❌ Error processing GnosisPay transaction:`, error.message);
          errors++;
        }
      }
    }

    logger.info(
      `✅ GnosisPay sync done: created=${created}, skipped=${skipped}, errors=${errors}`
    );

    return {
      created,
      updated: 0,
      skipped,
      errors,
      processed: gpTransactions.length,
    };
  } catch (error: any) {
    logger.error('❌ GnosisPay sync failed:', error.message);
    return { created: 0, updated: 0, skipped: 0, errors: 1, processed: 0 };
  }
}

function generateImportId(tx: GnosisPayTransaction): string {
  const txId = gnosispay.generateTransactionId(tx);
  const hash = crypto.createHash('md5').update(txId).digest('hex');
  // YNAB import_id max 36 chars: "GP:" (3) + 29 chars = 32 total
  return `GP:${hash.substring(0, 29)}`;
}

async function processTransaction(
  tx: GnosisPayTransaction,
  existingImportIds: Set<string>
): Promise<'created' | 'skipped'> {
  const importId = generateImportId(tx);

  // Already imported?
  if (existingImportIds.has(importId)) {
    logger.debug(`⏭️  GnosisPay: skipping existing ${tx.merchant.name} ${tx.billingAmount}`);
    return 'skipped';
  }

  // Skip pending transactions — they may change
  if (tx.isPending) {
    logger.debug(`⏭️  GnosisPay: skipping pending transaction ${tx.merchant.name}`);
    return 'skipped';
  }

  // Parse billing amount (cents string → EUR)
  // billingAmount is in minor units (cents), e.g. "2550" = 25.50 EUR
  const amountCents = parseInt(tx.billingAmount, 10);
  if (isNaN(amountCents) || amountCents === 0) {
    logger.debug(`⏭️  GnosisPay: skipping zero/invalid amount`);
    return 'skipped';
  }

  // Convert to YNAB milliunits: cents → milliunits (multiply by 10)
  // 2550 cents = 25.50 EUR = 25500 milliunits
  let ynabAmount = amountCents * 10;

  // GnosisPay: Payments are expenses (negative), Refunds are income (positive)
  if (tx.kind === 'Payment') {
    ynabAmount = -ynabAmount;
  } else if (tx.kind === 'Reversal') {
    // Reversals cancel previous charges → positive (money back)
    ynabAmount = Math.abs(ynabAmount);
  }
  // Refunds are already positive

  // Parse date
  const date = tx.clearedAt
    ? tx.clearedAt.split('T')[0]
    : tx.createdAt.split('T')[0];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    logger.warn(`⚠️  GnosisPay: invalid date ${tx.createdAt}`);
    return 'skipped';
  }

  // Build memo
  const currencyInfo = tx.transactionCurrency.code !== tx.billingCurrency.code
    ? ` (${tx.transactionAmount} ${tx.transactionCurrency.code})`
    : '';
  const city = tx.merchant.city ? `, ${tx.merchant.city}` : '';
  const country = tx.merchant.country?.alpha2 ? ` ${tx.merchant.country.alpha2}` : '';
  const memo = `${tx.kind}${currencyInfo}${city}${country}`;

  // Payee
  const payeeName = tx.merchant.name || 'GnosisPay';

  logger.info(
    `📤 GnosisPay → YNAB: ${date} | ${payeeName} | ` +
    `${(ynabAmount / 1000).toFixed(2)} EUR | ${tx.kind}`
  );

  await ynab.createTransaction(GNOSIS_PAY_BUDGET_ID, {
    account_id: GNOSIS_PAY_ACCOUNT_ID,
    date,
    amount: ynabAmount,
    payee_name: payeeName.substring(0, 100),
    memo: memo.substring(0, 500),
    cleared: 'cleared',
    approved: false,
    import_id: importId,
  });

  return 'created';
}
