import { airwallex } from '../clients/airwallex.js';
import { ynab } from '../clients/ynab.js';
import { supabase } from '../clients/supabase.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

// Airwallex USD account → YNAB Innerly budget
const YNAB_INNERLY_BUDGET_ID = '6dd20115-3f86-44d8-9dfa-911c699034dc';
const YNAB_AIRWALLEX_ACCOUNT_ID = '4469f27f-8e3b-4e26-9528-82c07aee1bdf';

export async function syncAirwallexToYnab(): Promise<{ created: number; updated: number; deleted: number; skipped: number; errors: number }> {
  if (!airwallex.isConfigured()) {
    logger.info('Airwallex not configured, skipping sync');
    return { created: 0, updated: 0, deleted: 0, skipped: 0, errors: 0 };
  }

  logger.info('✈️  Starting Airwallex → YNAB Innerly synchronization...');

  const startDate = `${config.syncStartDate}T00:00:00Z`;

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;

  try {
    // 1. Fetch USD transactions from Airwallex
    const transactions = await airwallex.getFinancialTransactions('USD', startDate);
    logger.info(`   Fetched ${transactions.length} USD transactions from Airwallex`);

    // 2. Process each transaction
    for (const awxTx of transactions) {
      try {
        // Skip non-settled transactions
        if (awxTx.status !== 'SETTLED') {
          logger.debug(`   Skipping non-settled transaction ${awxTx.id} (status: ${awxTx.status})`);
          skipped++;
          continue;
        }

        const existingMapping = await supabase.getAirwallexMapping(awxTx.id);

        const ynabAmount = airwallex.convertToMilliunits(awxTx.net);
        const date = airwallex.normalizeDate(awxTx.settled_at || awxTx.created_at);
        const memo = awxTx.description || `Airwallex ${awxTx.transaction_type}`;
        const importId = airwallex.generateImportId(awxTx);

        // Determine payee from description
        const payeeName = extractPayeeName(awxTx.description, awxTx.transaction_type);

        if (existingMapping) {
          // Check if updated
          const isUpdated =
            existingMapping.airwallex_amount !== awxTx.net ||
            existingMapping.airwallex_status !== awxTx.status;

          if (isUpdated) {
            logger.info(`   🔄 Updating YNAB transaction for Airwallex TX ${awxTx.id}`);

            await ynab.updateTransaction(YNAB_INNERLY_BUDGET_ID, existingMapping.ynab_transaction_id, {
              amount: ynabAmount,
              date,
              memo,
              cleared: 'cleared',
              approved: true,
            });

            await supabase.updateAirwallexMapping(awxTx.id, {
              airwallex_amount: awxTx.net,
              airwallex_status: awxTx.status,
            });

            updated++;
          } else {
            skipped++;
          }
          continue;
        }

        // 3. Create new transaction in YNAB
        logger.info(`   💰 Creating YNAB transaction: ${awxTx.id} - ${awxTx.net} USD (${awxTx.transaction_type})`);

        let currentImportId = importId;

        try {
          const ynabTx = await ynab.createTransaction(YNAB_INNERLY_BUDGET_ID, {
            account_id: YNAB_AIRWALLEX_ACCOUNT_ID,
            date,
            amount: ynabAmount,
            payee_name: payeeName || undefined,
            memo,
            cleared: 'cleared',
            approved: false,
            import_id: currentImportId,
          });

          await supabase.createAirwallexMapping(
            awxTx.id,
            awxTx.transaction_type,
            awxTx.created_at,
            YNAB_INNERLY_BUDGET_ID,
            YNAB_AIRWALLEX_ACCOUNT_ID,
            ynabTx.id,
            awxTx.net,
            awxTx.currency,
            awxTx.status,
            awxTx.description,
          );

          created++;
          logger.info(`   ✅ Created YNAB transaction for Airwallex TX ${awxTx.id}`);
        } catch (createError: any) {
          if (createError.message && createError.message.includes('409')) {
            logger.warn(`   ⚠️  Import ID conflict for ${importId}, retrying with timestamp...`);
            const timestamp = Date.now().toString().slice(-8);
            currentImportId = `${importId.substring(0, 27)}:${timestamp}`;

            try {
              const ynabTx = await ynab.createTransaction(YNAB_INNERLY_BUDGET_ID, {
                account_id: YNAB_AIRWALLEX_ACCOUNT_ID,
                date,
                amount: ynabAmount,
                payee_name: payeeName || undefined,
                memo,
                cleared: 'cleared',
                approved: false,
                import_id: currentImportId,
              });

              await supabase.createAirwallexMapping(
                awxTx.id,
                awxTx.transaction_type,
                awxTx.created_at,
                YNAB_INNERLY_BUDGET_ID,
                YNAB_AIRWALLEX_ACCOUNT_ID,
                ynabTx.id,
                awxTx.net,
                awxTx.currency,
                awxTx.status,
                awxTx.description,
              );

              created++;
            } catch (retryError: any) {
              if (retryError.message && retryError.message.includes('409')) {
                logger.debug(`   Transaction ${awxTx.id} already exists, skipping`);
                skipped++;
              } else {
                throw retryError;
              }
            }
          } else {
            throw createError;
          }
        }
      } catch (txError: any) {
        logger.error(`   ❌ Error processing Airwallex transaction ${awxTx.id}:`, txError.message);
      }
    }

    // 4. Handle deleted transactions
    const existingMappings = await supabase.getAirwallexMappings();
    const awxTxIds = new Set(transactions.map(tx => tx.id));

    for (const mapping of existingMappings) {
      if (!awxTxIds.has(mapping.airwallex_transaction_id)) {
        logger.info(`   🗑️  Airwallex transaction ${mapping.airwallex_transaction_id} no longer found, removing from YNAB...`);

        try {
          await ynab.deleteTransaction(YNAB_INNERLY_BUDGET_ID, mapping.ynab_transaction_id);
          await supabase.updateAirwallexMappingStatus(mapping.airwallex_transaction_id, 'deleted');
          deleted++;
        } catch (deleteError: any) {
          if (deleteError.message && deleteError.message.includes('404')) {
            logger.warn(`   ⚠️  YNAB transaction ${mapping.ynab_transaction_id} already deleted`);
            await supabase.updateAirwallexMappingStatus(mapping.airwallex_transaction_id, 'deleted');
            deleted++;
          } else {
            logger.error(`   ❌ Error deleting YNAB transaction:`, deleteError.message);
          }
        }
      }
    }

    logger.info(`\n✅ Airwallex sync completed!`);
    logger.info(`   Created: ${created}`);
    logger.info(`   Updated: ${updated}`);
    logger.info(`   Deleted: ${deleted}`);
    logger.info(`   Skipped: ${skipped}`);

    return { created, updated, deleted, skipped, errors: 0 };
  } catch (error: any) {
    logger.error('Error syncing Airwallex → YNAB:', error);
    return { created, updated, deleted, skipped, errors: 1 };
  }
}

function extractPayeeName(description: string | null, transactionType: string): string | null {
  if (!description) return null;

  // "FROM EPIC GROWTH LLC CONTRACTOR:AGE" → "EPIC GROWTH LLC"
  const fromMatch = description.match(/^FROM\s+(.+?)(?:\s+CONTRACTOR|$)/i);
  if (fromMatch) return fromMatch[1].trim();

  // "TO JOHN DOE" → "JOHN DOE"
  const toMatch = description.match(/^TO\s+(.+)/i);
  if (toMatch) return toMatch[1].trim();

  // For short descriptions, use as-is
  if (description.length <= 50) return description;

  return null;
}
