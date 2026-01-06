import { tron } from '../clients/tron.js';
import { ynab } from '../clients/ynab.js';
import { supabase } from '../clients/supabase.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

// Константы для Tron → YNAB Innerly
const YNAB_INNERLY_BUDGET_ID = '6dd20115-3f86-44d8-9dfa-911c699034dc';
const YNAB_INNERLY_TRON_ACCOUNT_ID = '6f1039a4-ea55-46f6-a833-74f6c067a1b3';

/**
 * Основная функция синхронизации Tron → YNAB Innerly
 */
export async function syncTronToYnab(): Promise<{ created: number; updated: number; skipped: number; deleted: number; errors: number }> {
  if (!tron.isConfigured()) {
    logger.info('Tron not configured, skipping sync');
    return;
  }

  logger.info('⛓️  Starting Tron → YNAB Innerly synchronization...');

  const startDate = config.syncStartDate;
  
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;

  try {
    const walletAddress = config.tronWalletAddress;

    // Получаем входящие и исходящие транзакции
    logger.info('   Fetching incoming USDT transactions...');
    const incomingTxs = await tron.getUsdtTransactions(startDate, 'in');
    
    logger.info('   Fetching outgoing USDT transactions...');
    const outgoingTxs = await tron.getUsdtTransactions(startDate, 'out');

    const allTxs = [...incomingTxs, ...outgoingTxs];
    logger.info(`   Total USDT transactions: ${allTxs.length} (${incomingTxs.length} in, ${outgoingTxs.length} out)`);

    // Обрабатываем каждую транзакцию
    for (const tronTx of allTxs) {
      try {
        // Определяем направление
        const direction = tronTx.to_address === walletAddress ? 'in' : 'out';

        // Проверяем, существует ли уже маппинг
        const existingMapping = await supabase.getTronMapping(walletAddress, tronTx.transaction_id);

        const ynabAmount = tron.convertToMilliunits(tronTx.quant, direction);
        const date = tron.normalizeDate(tronTx.block_ts);
        const importId = tron.generateImportId(tronTx.transaction_id);
        
        // Payee - это адрес отправителя (для входящих) или получателя (для исходящих)
        const counterpartyAddress = direction === 'in' ? tronTx.from_address : tronTx.to_address;
        const payeeName = tron.formatAddress(counterpartyAddress);
        const memo = `USDT ${direction === 'in' ? 'from' : 'to'} ${payeeName} | Tron`;

        // Проверяем на обновления
        if (existingMapping) {
          const isUpdated =
            existingMapping.tron_amount !== parseFloat(tronTx.quant) / 1e6 ||
            existingMapping.tron_block_ts !== tronTx.block_ts;

          if (isUpdated) {
            logger.info(`   🔄 Updating YNAB transaction for Tron TX ${tronTx.transaction_id.substring(0, 16)}...`);
            
            await ynab.updateTransaction(YNAB_INNERLY_BUDGET_ID, existingMapping.ynab_transaction_id, {
              amount: ynabAmount,
              date: date,
              memo: memo,
              cleared: 'cleared',
              approved: true,
            });

            await supabase.updateTronMapping(walletAddress, tronTx.transaction_id, {
              tron_amount: parseFloat(tronTx.quant) / 1e6,
              tron_block_ts: tronTx.block_ts,
            });

            updated++;
            logger.info(`   ✅ Updated YNAB transaction for Tron TX ${tronTx.transaction_id.substring(0, 16)}...`);
          } else {
            logger.debug(`   Transaction ${tronTx.transaction_id.substring(0, 16)}... already exists and is up-to-date, skipping`);
            skipped++;
          }
          continue;
        }

        // Создаем новую транзакцию в YNAB
        logger.info(`   💰 Creating YNAB transaction: ${tronTx.transaction_id.substring(0, 16)}... (${direction}) - ${ynabAmount / 1000} USD`);

        let currentImportId = importId;

        try {
          const ynabTx = await ynab.createTransaction(YNAB_INNERLY_BUDGET_ID, {
            account_id: YNAB_INNERLY_TRON_ACCOUNT_ID,
            date: date,
            amount: ynabAmount,
            payee_name: payeeName,
            memo: memo,
            cleared: 'cleared',
            approved: true,
            import_id: currentImportId,
          });

          await supabase.createTronMapping(
            walletAddress,
            tronTx.transaction_id,
            tronTx.block_ts,
            direction,
            tronTx.from_address,
            tronTx.to_address,
            YNAB_INNERLY_BUDGET_ID,
            YNAB_INNERLY_TRON_ACCOUNT_ID,
            ynabTx.id,
            parseFloat(tronTx.quant) / 1e6
          );

          created++;
          logger.info(`   ✅ Created YNAB transaction for Tron TX ${tronTx.transaction_id.substring(0, 16)}...`);
        } catch (createError: any) {
          if (createError.message && createError.message.includes('409')) {
            logger.warn(`   ⚠️  Import ID conflict for ${importId}, retrying with unique timestamp...`);
            const timestamp = Date.now().toString().slice(-7);
            currentImportId = `${importId.substring(0, 28)}:${timestamp}`;

            try {
              const ynabTx = await ynab.createTransaction(YNAB_INNERLY_BUDGET_ID, {
                account_id: YNAB_INNERLY_TRON_ACCOUNT_ID,
                date: date,
                amount: ynabAmount,
                payee_name: payeeName,
                memo: memo,
                cleared: 'cleared',
                approved: true,
                import_id: currentImportId,
              });

              await supabase.createTronMapping(
                walletAddress,
                tronTx.transaction_id,
                tronTx.block_ts,
                direction,
                tronTx.from_address,
                tronTx.to_address,
                YNAB_INNERLY_BUDGET_ID,
                YNAB_INNERLY_TRON_ACCOUNT_ID,
                ynabTx.id,
                parseFloat(tronTx.quant) / 1e6
              );

              created++;
              logger.info(`   ✅ Created YNAB transaction for Tron TX ${tronTx.transaction_id.substring(0, 16)}... with unique import_id: ${currentImportId}`);
            } catch (retryError: any) {
              if (retryError.message && retryError.message.includes('409')) {
                logger.debug(`   Transaction ${tronTx.transaction_id.substring(0, 16)}... already exists, skipping`);
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
        logger.error(`   ❌ Error processing Tron transaction ${tronTx.transaction_id.substring(0, 16)}...:`, txError.message);
      }
    }

    // Обрабатываем удаленные транзакции (не актуально для blockchain, но оставим для консистентности)
    const existingMappings = await supabase.getTronMappingsByWallet(walletAddress);
    const tronTxIds = new Set(allTxs.map(tx => tx.transaction_id));

    for (const mapping of existingMappings) {
      if (!tronTxIds.has(mapping.tron_transaction_id)) {
        logger.info(`   🗑️  Tron transaction ${mapping.tron_transaction_id.substring(0, 16)}... no longer found, marking as deleted...`);
        
        try {
          await ynab.deleteTransaction(YNAB_INNERLY_BUDGET_ID, mapping.ynab_transaction_id);
          await supabase.updateTronMappingStatus(walletAddress, mapping.tron_transaction_id, 'deleted');
          deleted++;
          logger.info(`   ✅ Deleted YNAB transaction ${mapping.ynab_transaction_id}`);
        } catch (deleteError: any) {
          if (deleteError.message && deleteError.message.includes('404')) {
            logger.warn(`   ⚠️  YNAB transaction ${mapping.ynab_transaction_id} already deleted`);
            await supabase.updateTronMappingStatus(walletAddress, mapping.tron_transaction_id, 'deleted');
            deleted++;
          } else {
            logger.error(`   ❌ Error deleting YNAB transaction ${mapping.ynab_transaction_id}:`, deleteError.message);
          }
        }
      }
    }

    logger.info(`\n✅ Tron sync completed!`);
    logger.info(`   Created: ${created}`);
    logger.info(`   Updated: ${updated}`);
    logger.info(`   Deleted: ${deleted}`);
    logger.info(`   Skipped: ${skipped}`);

    return { created, updated, deleted, skipped, errors: 0 };
  } catch (error: any) {
    logger.error('Error syncing Tron → YNAB:', error);
    return { created: 0, updated: 0, deleted: 0, skipped: 0, errors: 1 };
  }
}

