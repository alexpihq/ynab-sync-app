import { ZenmoneyClient, ZenmoneyTransaction } from '../clients/zenmoney.js';
import { ynab } from '../clients/ynab.js';
import { supabase } from '../clients/supabase.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { convertRubToEur } from './currency.js';

// Personal Budget Configuration
const PERSONAL_BUDGET_ID = '90024622-dd15-4ef9-bfad-4e555f5471ac';

// Account mapping: Zenmoney Account ID -> YNAB Account ID
const ACCOUNT_MAPPING: Record<string, { ynabAccountId: string; name: string }> = {
  // Alex TBank
  '22fdea45-0b17-4aab-9dc4-c3e7013ccf4e': {
    ynabAccountId: '4d79ac13-5af3-4974-ba36-bf6da266389c',
    name: 'Alex TBank'
  },
  '92bc1622-d60d-4178-b709-d68efaa3565b': {
    ynabAccountId: '4d79ac13-5af3-4974-ba36-bf6da266389c',
    name: 'Alex TBank'
  },
  // Jen TBank
  '74fd2c56-eaeb-4e33-864f-b0ee514804e3': {
    ynabAccountId: 'ad9cb006-c81c-437b-a80e-09bae0d51f85',
    name: 'Jen TBank'
  },
  // Jen Sber
  '02cdd4a2-8c4f-4f6b-bb9e-2a33706a5f0a': {
    ynabAccountId: 'a654aceb-7bae-4b53-8dd0-0c3fa99e4e92',
    name: 'Jen Sber'
  },
};

export async function syncZenmoneyToYnab(): Promise<void> {
  if (!config.zenmoneyToken) {
    logger.warn('Zenmoney token not configured, skipping sync');
    return;
  }

  logger.info('🔄 Starting Zenmoney → YNAB sync');

  try {
    const zenmoneyClient = new ZenmoneyClient(config.zenmoneyToken);

    // Get all transactions since 2026-01-01
    const sinceDate = new Date(config.syncStartDate);
    const accountIds = Object.keys(ACCOUNT_MAPPING);

    logger.info(`Fetching Zenmoney transactions for ${accountIds.length} accounts since ${sinceDate.toISOString()}`);

    const transactions = await zenmoneyClient.getTransactionsSince(accountIds, sinceDate);

    logger.info(`Fetched ${transactions.length} Zenmoney transactions`);

    // Process each account separately
    for (const accountId of accountIds) {
      const accountTransactions = transactions.filter(
        tx => tx.incomeAccount === accountId || tx.outcomeAccount === accountId
      );

      if (accountTransactions.length === 0) {
        logger.info(`No transactions for Zenmoney account ${accountId}`);
        continue;
      }

      await processZenmoneyAccount(accountId, accountTransactions);
    }

    logger.info('✅ Zenmoney → YNAB sync completed successfully');
  } catch (error: any) {
    logger.error('❌ Error during Zenmoney → YNAB sync:', error);
    throw error;
  }
}

async function processZenmoneyAccount(
  zenmoneyAccountId: string,
  transactions: ZenmoneyTransaction[]
): Promise<void> {
  const accountConfig = ACCOUNT_MAPPING[zenmoneyAccountId];
  
  if (!accountConfig) {
    logger.warn(`No YNAB mapping found for Zenmoney account ${zenmoneyAccountId}`);
    return;
  }

  logger.info(`Processing ${transactions.length} transactions for ${accountConfig.name}`);

  // Get existing mappings from Supabase
  const existingMappings = await supabase.getZenmoneyMappingsByAccount(
    zenmoneyAccountId,
    PERSONAL_BUDGET_ID
  );

  const processedIds = new Set(
    existingMappings
      .filter(m => m.status === 'created' || m.status === 'updated' || m.status === 'skipped')
      .map(m => m.zenmoney_transaction_id)
  );

  // Filter out transactions that have already been processed
  const newTransactions = transactions.filter(tx => !processedIds.has(tx.id));

  logger.info(`Found ${newTransactions.length} new transactions to sync`);

  for (const transaction of newTransactions) {
    try {
      await processZenmoneyTransaction(zenmoneyAccountId, accountConfig.ynabAccountId, transaction);
    } catch (error: any) {
      // Don't log 409 errors (duplicates) as errors - they're handled gracefully
      if (!error.message?.includes('409') && !error.message?.includes('import_id already exists')) {
        logger.error(`Error processing Zenmoney transaction ${transaction.id}:`, error);
      }
      // Continue with next transaction
    }
  }
}

async function processZenmoneyTransaction(
  zenmoneyAccountId: string,
  ynabAccountId: string,
  transaction: ZenmoneyTransaction
): Promise<void> {
  // Determine if this is income or outcome
  const isIncome = transaction.incomeAccount === zenmoneyAccountId;
  const isOutcome = transaction.outcomeAccount === zenmoneyAccountId;

  // Get RUB amount (Zenmoney returns rubles with kopecks as decimal, e.g. 19584.19)
  // For internal transactions (income == outcome account), use whichever amount is non-zero
  let rubAmountDecimal: number;
  if (isIncome && isOutcome) {
    // Internal transaction (fee, refund, etc.) - use non-zero amount
    rubAmountDecimal = transaction.outcome > 0 ? transaction.outcome : transaction.income;
  } else if (isIncome) {
    rubAmountDecimal = transaction.income;
  } else if (isOutcome) {
    rubAmountDecimal = transaction.outcome;
  } else {
    rubAmountDecimal = 0;
  }

  if (rubAmountDecimal === 0) {
    logger.debug(`Skipping zero amount transaction ${transaction.id}`);
    return;
  }

  // Convert to milliunits (kopecks) for YNAB and currency conversion
  // 19584.19 RUB → 1958419 kopecks
  const rubAmountMilliunits = Math.round(rubAmountDecimal * 100);

  // Convert RUB milliunits to EUR milliunits
  const eurAmount = await convertRubToEur(rubAmountMilliunits, transaction.date);

  if (eurAmount === null) {
    logger.error(`Failed to convert RUB to EUR for transaction ${transaction.id} on ${transaction.date}`);
    await supabase.updateZenmoneyMappingStatus(
      transaction.id,
      zenmoneyAccountId,
      PERSONAL_BUDGET_ID,
      'error',
      'Failed to get exchange rate'
    );
    return;
  }

  // Format payee and memo
  const payee = transaction.payee || transaction.originalPayee || 'Zenmoney Transaction';
  // Show rubles with kopecks as Zenmoney returns them
  const rubFormatted = rubAmountDecimal.toFixed(2);
  const memo = `${transaction.comment || ''} | ${rubFormatted} ₽`.trim();

  // Prepare YNAB transaction
  // Include zenmoneyAccountId in import_id to make it unique per account
  // Format: ZM:ACCT:YYYYMMDD:AMT:TXID (max 36 chars for YNAB)
  const accountPrefix = zenmoneyAccountId.substring(0, 4); // 4 chars
  const dateCompact = transaction.date.replace(/-/g, ''); // YYYYMMDD (8 chars)
  const txIdShort = transaction.id.substring(0, 6); // 6 chars
  // Total: ZM(2) + :(1) + ACCT(4) + :(1) + DATE(8) + :(1) + AMT(1-10) + :(1) + TXID(6) = ~24-33 chars
  // Determine direction: if outcome was used, it's an expense (negative)
  const isExpense = transaction.outcome > 0 && rubAmountDecimal === transaction.outcome;
  const ynabTransaction = {
    account_id: ynabAccountId,
    date: transaction.date,
    amount: isExpense ? -eurAmount : eurAmount,
    payee_name: payee,
    memo: memo.substring(0, 200), // YNAB memo limit
    cleared: 'cleared' as const,
    approved: false, // Import as unapproved (like other syncs)
    import_id: `ZM:${accountPrefix}:${dateCompact}:${Math.abs(eurAmount)}:${txIdShort}`,
  };

  // Check if mapping already exists
  const existingMapping = await supabase.getZenmoneyMapping(
    transaction.id,
    zenmoneyAccountId,
    PERSONAL_BUDGET_ID
  );

  try {
    if (existingMapping) {
      // Update existing mapping
      logger.debug(`Updating mapping for Zenmoney transaction ${transaction.id}`);
      
      await supabase.updateZenmoneyMappingStatus(
        transaction.id,
        zenmoneyAccountId,
        PERSONAL_BUDGET_ID,
        'pending'
      );

      // Create or update YNAB transaction
      try {
        const createdTx = await ynab.createTransaction(PERSONAL_BUDGET_ID, ynabTransaction);

        await supabase.updateZenmoneyMappingYnabId(
          transaction.id,
          zenmoneyAccountId,
          PERSONAL_BUDGET_ID,
          createdTx.id
        );

        logger.info(`✅ Updated Zenmoney transaction ${transaction.id} → YNAB ${createdTx.id}`);
      } catch (ynabError: any) {
        // If it's a duplicate (409 conflict), mark as skipped instead of error
        if (ynabError.message?.includes('409') || ynabError.message?.includes('import_id already exists')) {
          await supabase.updateZenmoneyMappingStatus(
            transaction.id,
            zenmoneyAccountId,
            PERSONAL_BUDGET_ID,
            'skipped',
            'Duplicate import_id in YNAB'
          );
          logger.debug(`⏭️  Skipped duplicate Zenmoney transaction ${transaction.id}`);
        } else {
          throw ynabError;
        }
      }
    } else {
      // Create new mapping
      logger.debug(`Creating new mapping for Zenmoney transaction ${transaction.id}`);

      // Save milliunits (kopecks) to Supabase
      await supabase.createZenmoneyMapping(
        transaction.id,
        zenmoneyAccountId,
        PERSONAL_BUDGET_ID,
        ynabAccountId,
        rubAmountMilliunits, // Already integer (kopecks)
        eurAmount, // Already integer (EUR milliunits)
        transaction.date,
        payee,
        memo
      );

      // Create YNAB transaction
      try {
        const createdTx = await ynab.createTransaction(PERSONAL_BUDGET_ID, ynabTransaction);

        await supabase.updateZenmoneyMappingYnabId(
          transaction.id,
          zenmoneyAccountId,
          PERSONAL_BUDGET_ID,
          createdTx.id
        );

        logger.info(`✅ Created Zenmoney transaction ${transaction.id} → YNAB ${createdTx.id}`);
      } catch (ynabError: any) {
        // If it's a duplicate (409 conflict), mark as skipped instead of error
        if (ynabError.message?.includes('409') || ynabError.message?.includes('import_id already exists')) {
          await supabase.updateZenmoneyMappingStatus(
            transaction.id,
            zenmoneyAccountId,
            PERSONAL_BUDGET_ID,
            'skipped',
            'Duplicate import_id in YNAB'
          );
          logger.debug(`⏭️  Skipped duplicate Zenmoney transaction ${transaction.id}`);
        } else {
          throw ynabError;
        }
      }
    }
  } catch (error: any) {
    logger.error(`Error creating/updating YNAB transaction for Zenmoney ${transaction.id}:`, error);
    
    await supabase.updateZenmoneyMappingStatus(
      transaction.id,
      zenmoneyAccountId,
      PERSONAL_BUDGET_ID,
      'error',
      error.message
    );
  }
}

