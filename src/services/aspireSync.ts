import { aspire } from '../clients/aspire.js';
import { ynab } from '../clients/ynab.js';
import { supabase } from '../clients/supabase.js';
import { convertEurToUsd, convertSgdToUsd } from './currency.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

// Константы для Aspire Bank → YNAB Innerly
const ASPIRE_ACCOUNTS = {
  USD: {
    aspireAccountId: '9d6d2e6b-4833-4b73-bdeb-a80718916cb3',
    ynabAccountId: 'c0f153ff-5ca4-4697-ac36-4d96460d9784',
    currency: 'USD' as const,
  },
  SGD: {
    aspireAccountId: '9d6c59f9-dd95-43c2-b333-56c2b6e38bc8',
    ynabAccountId: '3ccfd1e4-d8c2-41f5-b2f5-a3923155c707',
    currency: 'SGD' as const,
  },
  EUR: {
    aspireAccountId: '9d6c69a5-abea-4895-9601-1a0cfeb63473',
    ynabAccountId: 'b3d64d0f-8daa-4d90-9863-2c64cbee1f8c',
    currency: 'EUR' as const,
  },
};

const YNAB_INNERLY_BUDGET_ID = '6dd20115-3f86-44d8-9dfa-911c699034dc';

/**
 * Основная функция синхронизации Aspire → YNAB Innerly
 */
export async function syncAspireToYnab(): Promise<{ created: number; updated: number; deleted: number; skipped: number; errors: number }> {
  if (!aspire.isConfigured()) {
    logger.info('Aspire Bank not configured, skipping sync');
    return { created: 0, updated: 0, deleted: 0, skipped: 0, errors: 0 };
  }

  logger.info('🏦 Starting Aspire Bank → YNAB Innerly synchronization...');

  const startDate = `${config.syncStartDate}T00:00:00Z`;
  
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;
  let totalSkipped = 0;

  try {
    // Обрабатываем каждый счет
    for (const [accountName, accountConfig] of Object.entries(ASPIRE_ACCOUNTS)) {
      logger.info(`\n💳 Processing ${accountName} account...`);
      
      const stats = await processAspireAccount(
        accountConfig.aspireAccountId,
        accountConfig.ynabAccountId,
        accountConfig.currency,
        startDate
      );
      
      totalCreated += stats.created;
      totalUpdated += stats.updated;
      totalDeleted += stats.deleted;
      totalSkipped += stats.skipped;
    }

    logger.info(`\n✅ Aspire sync completed!`);
    logger.info(`   Created: ${totalCreated}`);
    logger.info(`   Updated: ${totalUpdated}`);
    logger.info(`   Deleted: ${totalDeleted}`);
    logger.info(`   Skipped: ${totalSkipped}`);

    return { created: totalCreated, updated: totalUpdated, deleted: totalDeleted, skipped: totalSkipped, errors: 0 };
  } catch (error: any) {
    logger.error('Error syncing Aspire → YNAB:', error);
    
    // Если это Cloudflare Challenge, не считаем это критической ошибкой
    const isCloudflareError = error.message && (
      error.message.includes('Cloudflare Challenge') ||
      error.message.includes('Just a moment')
    );
    
    if (isCloudflareError) {
      logger.warn('⚠️  Aspire sync skipped due to Cloudflare protection. This is temporary and will be retried on next sync.');
      // Возвращаем успешный результат, но с ошибкой, чтобы показать в UI
      return { created: totalCreated, updated: totalUpdated, deleted: totalDeleted, skipped: totalSkipped, errors: 1 };
    }
    
    return { created: 0, updated: 0, deleted: 0, skipped: 0, errors: 1 };
  }
}

/**
 * Обрабатывает один счет Aspire и синхронизирует с YNAB
 */
async function processAspireAccount(
  aspireAccountId: string,
  ynabAccountId: string,
  currency: 'USD' | 'SGD' | 'EUR',
  startDate: string
): Promise<{ created: number; updated: number; deleted: number; skipped: number }> {
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;

  try {
    // 1. Получаем транзакции из Aspire
    const aspireTransactions = await aspire.getTransactions(aspireAccountId, startDate);
    logger.info(`   Fetched ${aspireTransactions.length} transactions from Aspire ${currency}`);

    // 2. Обрабатываем каждую транзакцию
    for (const aspireTx of aspireTransactions) {
      try {
        // Проверяем, существует ли уже маппинг
        const existingMapping = await supabase.getAspireMapping(aspireAccountId, aspireTx.id);

        // Конвертируем сумму из Aspire в YNAB milliunits
        const aspireMilliunits = aspire.convertToMilliunits(aspireTx.amount);
        let ynabAmount: number | null = null;

        // Конвертируем валюту если нужно
        if (currency === 'USD') {
          ynabAmount = aspireMilliunits; // Без конвертации
        } else if (currency === 'EUR') {
          ynabAmount = await convertEurToUsd(aspireMilliunits, aspire.normalizeDate(aspireTx.datetime));
        } else if (currency === 'SGD') {
          ynabAmount = await convertSgdToUsd(aspireMilliunits, aspire.normalizeDate(aspireTx.datetime));
        }

        if (ynabAmount === null) {
          logger.warn(`   ⚠️  Could not convert ${currency} to USD for transaction ${aspireTx.id}, skipping`);
          skipped++;
          continue;
        }

        const date = aspire.normalizeDate(aspireTx.datetime);
        const counterpartyName = aspire.cleanCounterpartyName(aspireTx.counterparty_name);
        const memo = aspireTx.reference || counterpartyName || 'Aspire Bank';
        const importId = aspire.generateImportId(aspireTx);

        // Проверяем, был ли изменен
        if (existingMapping) {
          const isUpdated =
            existingMapping.aspire_amount !== aspireTx.amount ||
            existingMapping.aspire_datetime !== aspireTx.datetime ||
            existingMapping.aspire_reference !== aspireTx.reference;

          if (isUpdated) {
            logger.info(`   🔄 Updating YNAB transaction for Aspire TX ${aspireTx.id}`);
            
            await ynab.updateTransaction(YNAB_INNERLY_BUDGET_ID, existingMapping.ynab_transaction_id, {
              amount: ynabAmount,
              date: date,
              memo: memo,
              cleared: 'cleared',
              approved: true,
            });

            await supabase.updateAspireMappingYnabId(
              aspireAccountId,
              aspireTx.id,
              existingMapping.ynab_transaction_id,
              aspireTx.amount,
              aspireTx.datetime,
              aspireTx.reference
            );

            updated++;
            logger.info(`   ✅ Updated YNAB transaction for Aspire TX ${aspireTx.id}`);
          } else {
            logger.debug(`   Transaction ${aspireTx.id} already exists and is up-to-date, skipping`);
            skipped++;
          }
          continue;
        }

        // 3. Создаем новую транзакцию в YNAB
        logger.info(`   💰 Creating YNAB transaction: ${aspireTx.id} (${currency}) - ${ynabAmount / 1000} USD`);

        let currentImportId = importId;

        try {
          const ynabTx = await ynab.createTransaction(YNAB_INNERLY_BUDGET_ID, {
            account_id: ynabAccountId,
            date: date,
            amount: ynabAmount,
            payee_name: counterpartyName || undefined,
            memo: memo,
            cleared: 'cleared',
            approved: true,
            import_id: currentImportId,
          });

          await supabase.createAspireMapping(
            aspireAccountId,
            aspireTx.id,
            aspireTx.datetime,
            YNAB_INNERLY_BUDGET_ID,
            ynabAccountId,
            ynabTx.id,
            aspireTx.amount,
            currency,
            aspireTx.reference
          );

          created++;
          logger.info(`   ✅ Created YNAB transaction for Aspire TX ${aspireTx.id}`);
        } catch (createError: any) {
          if (createError.message && createError.message.includes('409')) {
            logger.warn(`   ⚠️  Import ID conflict for ${importId}, retrying with unique timestamp...`);
            const timestamp = Date.now().toString().slice(-8);
            currentImportId = `${importId}:${timestamp}`;

            try {
              const ynabTx = await ynab.createTransaction(YNAB_INNERLY_BUDGET_ID, {
                account_id: ynabAccountId,
                date: date,
                amount: ynabAmount,
                payee_name: counterpartyName || undefined,
                memo: memo,
                cleared: 'cleared',
                approved: true,
                import_id: currentImportId,
              });

              await supabase.createAspireMapping(
                aspireAccountId,
                aspireTx.id,
                aspireTx.datetime,
                YNAB_INNERLY_BUDGET_ID,
                ynabAccountId,
                ynabTx.id,
                aspireTx.amount,
                currency,
                aspireTx.reference
              );

              created++;
              logger.info(`   ✅ Created YNAB transaction for Aspire TX ${aspireTx.id} with unique import_id: ${currentImportId}`);
            } catch (retryError: any) {
              if (retryError.message && retryError.message.includes('409')) {
                logger.debug(`   Transaction ${aspireTx.id} already exists, skipping`);
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
        logger.error(`   ❌ Error processing Aspire transaction ${aspireTx.id}:`, txError.message);
      }
    }

    // 4. Обрабатываем удаленные транзакции
    const existingMappings = await supabase.getAspireMappingsByAccount(aspireAccountId);
    const aspireTxIds = new Set(aspireTransactions.map(tx => tx.id));

    for (const mapping of existingMappings) {
      if (!aspireTxIds.has(mapping.aspire_transaction_id)) {
        logger.info(`   🗑️  Aspire transaction ${mapping.aspire_transaction_id} was deleted, removing from YNAB...`);
        
        try {
          await ynab.deleteTransaction(YNAB_INNERLY_BUDGET_ID, mapping.ynab_transaction_id);
          await supabase.updateAspireMappingStatus(aspireAccountId, mapping.aspire_transaction_id, 'deleted');
          deleted++;
          logger.info(`   ✅ Deleted YNAB transaction ${mapping.ynab_transaction_id}`);
        } catch (deleteError: any) {
          if (deleteError.message && deleteError.message.includes('404')) {
            logger.warn(`   ⚠️  YNAB transaction ${mapping.ynab_transaction_id} already deleted`);
            await supabase.updateAspireMappingStatus(aspireAccountId, mapping.aspire_transaction_id, 'deleted');
            deleted++;
          } else {
            logger.error(`   ❌ Error deleting YNAB transaction ${mapping.ynab_transaction_id}:`, deleteError.message);
          }
        }
      }
    }

    logger.info(`   📊 ${currency}: Created ${created}, Updated ${updated}, Deleted ${deleted}, Skipped ${skipped}`);

    return { created, updated, deleted, skipped };
  } catch (error: any) {
    // Проверяем, является ли это Cloudflare Challenge
    const isCloudflareError = error.message && (
      error.message.includes('Cloudflare Challenge') ||
      error.message.includes('Just a moment') ||
      error.message.includes('cf-challenge')
    );
    
    if (isCloudflareError) {
      logger.warn(`⚠️  Cloudflare Challenge detected for account ${aspireAccountId}. Skipping this account for now.`);
      // Не бросаем ошибку дальше, просто возвращаем пустые результаты
      return { created: 0, updated: 0, deleted: 0, skipped: 0 };
    }
    
    logger.error(`Error processing Aspire account ${aspireAccountId}:`, error);
    throw error;
  }
}

