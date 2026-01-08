import { tbank } from '../clients/tbank.js';
import { ynab } from '../clients/ynab.js';
import { supabase } from '../clients/supabase.js';
import { convertRubToUsd } from './currency.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

// Константы для TBank → YNAB
// Конвертируем RUB в USD и загружаем в указанный бюджет
const TBANK_ACCOUNTS = {
  RUB: {
    tbankAccountNumber: '40802810300000990185', // Рублевый счет ТБанка
    ynabAccountId: 'd92d652a-a66b-4081-93ff-f8b46fe49248', // YNAB account ID
    currency: 'RUB' as const,
  },
};

// Budget ID для загрузки транзакций
const YNAB_BUDGET_ID = '9c2dd1ba-36c2-4cb9-9428-6882160a155a';

/**
 * Основная функция синхронизации TBank → YNAB
 */
export async function syncTbankToYnab(): Promise<{ created: number; updated: number; deleted: number; skipped: number; errors: number }> {
  if (!tbank.isConfigured()) {
    logger.info('TBank not configured, skipping sync');
    return { created: 0, updated: 0, deleted: 0, skipped: 0, errors: 0 };
  }

  logger.info('🏦 Starting TBank → YNAB synchronization...');

  const startDate = `${config.syncStartDate}T00:00:00Z`;
  const endDate = new Date().toISOString();
  
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  try {
    // Обрабатываем каждый счет
    for (const [accountName, accountConfig] of Object.entries(TBANK_ACCOUNTS)) {
      // Пропускаем счета без настроенного YNAB account ID
      if (!accountConfig.ynabAccountId) {
        logger.warn(`⚠️  ${accountName} account has no YNAB account ID configured, skipping`);
        continue;
      }

      logger.info(`\n💳 Processing ${accountName} account...`);
      
      const stats = await processTbankAccount(
        accountConfig.tbankAccountNumber,
        accountConfig.ynabAccountId,
        accountConfig.currency,
        startDate,
        endDate
      );
      
      totalCreated += stats.created;
      totalUpdated += stats.updated;
      totalDeleted += stats.deleted;
      totalSkipped += stats.skipped;
      totalErrors += stats.errors;
    }

    logger.info(`\n✅ TBank sync completed!`);
    logger.info(`   Created: ${totalCreated}`);
    logger.info(`   Updated: ${totalUpdated}`);
    logger.info(`   Deleted: ${totalDeleted}`);
    logger.info(`   Skipped: ${totalSkipped}`);
    logger.info(`   Errors: ${totalErrors}`);

    return { created: totalCreated, updated: totalUpdated, deleted: totalDeleted, skipped: totalSkipped, errors: totalErrors };
  } catch (error: any) {
    logger.error('Error syncing TBank → YNAB:', error);
    return { created: 0, updated: 0, deleted: 0, skipped: 0, errors: 1 };
  }
}

/**
 * Обрабатывает один счет TBank и синхронизирует с YNAB
 */
async function processTbankAccount(
  tbankAccountNumber: string,
  ynabAccountId: string,
  currency: 'RUB' | 'USD' | 'GBP',
  startDate: string,
  endDate: string
): Promise<{ created: number; updated: number; deleted: number; skipped: number; errors: number }> {
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;
  let errors = 0;

  try {
    // 1. Получаем операции из TBank
    const tbankOperations = await tbank.getAllOperations(
      tbankAccountNumber,
      startDate,
      endDate,
      'Transaction' // Только подтвержденные транзакции
    );
    logger.info(`   Fetched ${tbankOperations.length} operations from TBank ${currency}`);

    // 2. Обрабатываем каждую операцию
    for (const operation of tbankOperations) {
      try {
        // Пропускаем операции не в нужной валюте
        const opCurrency = tbank.getCurrencyCode(operation.accountCurrencyDigitalCode);
        if (opCurrency !== currency) {
          logger.debug(`   Skipping operation ${operation.operationId}: currency mismatch (${opCurrency} vs ${currency})`);
          skipped++;
          continue;
        }

        // Проверяем, существует ли уже маппинг
        const existingMapping = await supabase.getTbankMapping(tbankAccountNumber, operation.operationId);

        // Конвертируем сумму из TBank в YNAB milliunits
        const tbankMilliunits = tbank.convertToMilliunits(operation.accountAmount);

        // Конвертируем валюту если нужно
        let ynabAmount: number | null = null;
        
        if (currency === 'RUB') {
          // Конвертируем RUB -> USD через курсы в Supabase (RUB -> EUR -> USD)
          ynabAmount = await convertRubToUsd(tbankMilliunits, tbank.normalizeDate(operation.operationDate));
        } else if (currency === 'USD') {
          // Без конвертации
          ynabAmount = tbankMilliunits;
        } else {
          logger.warn(`   ⚠️  Unsupported currency ${currency} for operation ${operation.operationId}, skipping`);
          skipped++;
          continue;
        }

        if (ynabAmount === null) {
          logger.warn(`   ⚠️  Could not convert ${currency} to USD for operation ${operation.operationId}, skipping`);
          skipped++;
          continue;
        }

        // Инвертируем знак для дебетовых операций (списание)
        const finalAmount = operation.typeOfOperation === 'Debit' ? -Math.abs(ynabAmount) : Math.abs(ynabAmount);

        const date = tbank.normalizeDate(operation.operationDate);
        const payeeName = tbank.getPayeeName(operation);
        const memo = tbank.formatMemo(operation);
        const importId = tbank.generateImportId(operation);

        // Проверяем, был ли изменен
        if (existingMapping) {
          const isUpdated =
            existingMapping.tbank_amount !== operation.accountAmount ||
            existingMapping.tbank_operation_date !== operation.operationDate;

          if (isUpdated) {
            logger.info(`   🔄 Updating YNAB transaction for TBank operation ${operation.operationId}`);
            
            await ynab.updateTransaction(YNAB_BUDGET_ID, existingMapping.ynab_transaction_id, {
              amount: finalAmount,
              date: date,
              memo: memo,
              cleared: 'cleared',
              approved: true,
            });

            await supabase.updateTbankMappingYnabId(
              tbankAccountNumber,
              operation.operationId,
              existingMapping.ynab_transaction_id,
              operation.accountAmount,
              operation.operationDate
            );

            updated++;
            logger.info(`   ✅ Updated YNAB transaction for TBank operation ${operation.operationId}`);
          } else {
            logger.debug(`   Operation ${operation.operationId} already exists and is up-to-date, skipping`);
            skipped++;
          }
          continue;
        }

        // 3. Создаем новую транзакцию в YNAB
        const displayAmount = currency === 'RUB' 
          ? `${operation.accountAmount} RUB → ${(finalAmount / 1000).toFixed(2)} USD`
          : `${(finalAmount / 1000).toFixed(2)} ${currency}`;
        logger.info(`   💰 Creating YNAB transaction: ${operation.operationId} - ${displayAmount}`);

        let currentImportId = importId;

        try {
          const ynabTx = await ynab.createTransaction(YNAB_BUDGET_ID, {
            account_id: ynabAccountId,
            date: date,
            amount: finalAmount,
            payee_name: payeeName || undefined,
            memo: memo,
            cleared: 'cleared',
            approved: false, // Requires manual approval in YNAB
            import_id: currentImportId,
          });

          await supabase.createTbankMapping(
            tbankAccountNumber,
            operation.operationId,
            operation.operationDate,
            YNAB_BUDGET_ID,
            ynabAccountId,
            ynabTx.id,
            operation.accountAmount,
            currency
          );

          created++;
          logger.info(`   ✅ Created YNAB transaction for TBank operation ${operation.operationId}`);
        } catch (createError: any) {
          if (createError.message && createError.message.includes('409')) {
            logger.warn(`   ⚠️  Import ID conflict for ${importId}, retrying with unique timestamp...`);
            const timestamp = Date.now().toString().slice(-8);
            currentImportId = `${importId}:${timestamp}`;

            try {
              const ynabTx = await ynab.createTransaction(YNAB_BUDGET_ID, {
                account_id: ynabAccountId,
                date: date,
                amount: finalAmount,
                payee_name: payeeName || undefined,
                memo: memo,
                cleared: 'cleared',
                approved: false,
                import_id: currentImportId,
              });

              await supabase.createTbankMapping(
                tbankAccountNumber,
                operation.operationId,
                operation.operationDate,
                YNAB_BUDGET_ID,
                ynabAccountId,
                ynabTx.id,
                operation.accountAmount,
                currency
              );

              created++;
              logger.info(`   ✅ Created YNAB transaction for TBank operation ${operation.operationId} with unique import_id: ${currentImportId}`);
            } catch (retryError: any) {
              if (retryError.message && retryError.message.includes('409')) {
                logger.debug(`   Operation ${operation.operationId} already exists, skipping`);
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
        logger.error(`   ❌ Error processing TBank operation ${operation.operationId}:`, txError.message);
        errors++;
      }
    }

    // 4. Обрабатываем удаленные операции (опционально)
    // TBank API не удаляет операции, поэтому эта логика может не понадобиться
    // Но оставляю для полноты, если понадобится в будущем
    const existingMappings = await supabase.getTbankMappingsByAccount(tbankAccountNumber);
    const tbankOpIds = new Set(tbankOperations.map(op => op.operationId));

    for (const mapping of existingMappings) {
      if (!tbankOpIds.has(mapping.tbank_operation_id) && mapping.sync_status === 'active') {
        logger.info(`   🗑️  TBank operation ${mapping.tbank_operation_id} no longer in statement, marking as deleted...`);
        
        try {
          // Опционально: можно удалить транзакцию из YNAB
          // await ynab.deleteTransaction(YNAB_BUDGET_ID, mapping.ynab_transaction_id);
          
          // Или просто пометить в базе как удаленную
          await supabase.updateTbankMappingStatus(tbankAccountNumber, mapping.tbank_operation_id, 'deleted');
          deleted++;
          logger.info(`   ✅ Marked TBank operation ${mapping.tbank_operation_id} as deleted`);
        } catch (deleteError: any) {
          logger.error(`   ❌ Error marking operation ${mapping.tbank_operation_id} as deleted:`, deleteError.message);
          errors++;
        }
      }
    }

    logger.info(`   📊 ${currency}: Created ${created}, Updated ${updated}, Deleted ${deleted}, Skipped ${skipped}, Errors ${errors}`);

    return { created, updated, deleted, skipped, errors };
  } catch (error: any) {
    logger.error(`Error processing TBank account ${tbankAccountNumber}:`, error);
    throw error;
  }
}

