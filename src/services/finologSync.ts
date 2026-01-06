import { finolog } from '../clients/finolog.js';
import { ynab } from '../clients/ynab.js';
import { supabase } from '../clients/supabase.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { convertRubToEur, convertEurToUsd, convertEurToRub } from './currency.js';

/**
 * Конфигурация для Finolog аккаунтов
 */
export interface FinologAccountConfig {
  finologBizId: number;
  finologAccountId: number;
  finologCurrency: 'EUR' | 'USD' | 'RUB';
  ynabBudgetId: string;
  ynabAccountId: string;
  ynabCurrency: 'EUR' | 'USD' | 'RUB';
}

/**
 * Конфигурация для Epic Web3
 * 
 * Epic Web3 ведется в Финологе и синхронизируется в личный бюджет Alex
 * Все транзакции попадают в один аккаунт и конвертируются в EUR
 */
const ALEX_PERSONAL_BUDGET_ID = '90024622-dd15-4ef9-bfad-4e555f5471ac';
const EPIC_WEB3_ACCOUNT_IN_ALEX = '5f0d008f-0104-4b0c-bf70-1e3bf516e315';

const EPIC_WEB3_CONFIG: FinologAccountConfig[] = [
  {
    finologBizId: 47504,
    finologAccountId: 161752,
    finologCurrency: 'RUB',
    ynabBudgetId: ALEX_PERSONAL_BUDGET_ID,
    ynabAccountId: EPIC_WEB3_ACCOUNT_IN_ALEX,
    ynabCurrency: 'EUR', // Всегда EUR (валюта личного бюджета)
  },
  {
    finologBizId: 47504,
    finologAccountId: 168187,
    finologCurrency: 'EUR',
    ynabBudgetId: ALEX_PERSONAL_BUDGET_ID,
    ynabAccountId: EPIC_WEB3_ACCOUNT_IN_ALEX,
    ynabCurrency: 'EUR',
  },
  {
    finologBizId: 47504,
    finologAccountId: 161666,
    finologCurrency: 'USD',
    ynabBudgetId: ALEX_PERSONAL_BUDGET_ID,
    ynabAccountId: EPIC_WEB3_ACCOUNT_IN_ALEX,
    ynabCurrency: 'EUR',
  },
];

/**
 * Конвертирует сумму между валютами
 */
async function convertCurrency(
  amount: number,
  fromCurrency: 'EUR' | 'USD' | 'RUB',
  toCurrency: 'EUR' | 'USD' | 'RUB',
  date: string
): Promise<number | null> {
  if (fromCurrency === toCurrency) {
    return amount;
  }

  // Конвертируем через EUR как базовую валюту
  let amountInEur = amount;

  // Сначала конвертируем в EUR (если нужно)
  if (fromCurrency === 'USD') {
    const rate = await supabase.getExchangeRate(date.substring(0, 7));
    if (!rate) return null;
    amountInEur = Math.round(amount / rate);
  } else if (fromCurrency === 'RUB') {
    amountInEur = await convertRubToEur(amount, date) ?? 0;
    if (!amountInEur) return null;
  }

  // Затем конвертируем из EUR в целевую валюту (если нужно)
  if (toCurrency === 'USD') {
    return await convertEurToUsd(amountInEur, date);
  } else if (toCurrency === 'RUB') {
    return await convertEurToRub(amountInEur, date);
  }

  return amountInEur;
}


/**
 * Обрабатывает удаленные транзакции из Finolog
 */
async function handleDeletedFinologTransactions(
  accountConfig: FinologAccountConfig,
  currentFinologTxIds: Set<number>
): Promise<number> {
  const { finologAccountId, ynabBudgetId } = accountConfig;

  // Получаем все активные маппинги для этого аккаунта
  const mappings = await supabase.getFinologMappingsByAccount(finologAccountId);
  
  let deleted = 0;

  for (const mapping of mappings) {
    // Если транзакция больше не существует в Finolog - удаляем в YNAB
    if (!currentFinologTxIds.has(mapping.finolog_transaction_id)) {
      logger.info(`🗑️  Finolog transaction ${mapping.finolog_transaction_id} was deleted, removing from YNAB...`);
      
      try {
        await ynab.deleteTransaction(ynabBudgetId, mapping.ynab_transaction_id);
        await supabase.updateFinologMappingStatus(
          finologAccountId,
          mapping.finolog_transaction_id,
          'deleted'
        );
        deleted++;
        logger.info(`✅ Deleted YNAB transaction ${mapping.ynab_transaction_id}`);
      } catch (error: any) {
        logger.error(`Error deleting YNAB transaction ${mapping.ynab_transaction_id}:`, error.message);
      }
    }
  }

  return deleted;
}

/**
 * Синхронизирует транзакции из Finolog в YNAB для одного аккаунта
 */
async function syncFinologAccount(accountConfig: FinologAccountConfig): Promise<void> {
  const {
    finologBizId,
    finologAccountId,
    finologCurrency,
    ynabBudgetId,
    ynabAccountId,
    ynabCurrency,
  } = accountConfig;

  logger.info(`🔄 Starting Finolog sync: Account ${finologAccountId} (${finologCurrency}) -> YNAB ${ynabAccountId} (${ynabCurrency})`);

  // Получаем транзакции из Finolog начиная с syncStartDate
  const fromDate = config.syncStartDate;
  const toDate = new Date().toISOString().split('T')[0]; // Today

  const finologTransactions = await finolog.getTransactions(
    finologBizId,
    finologAccountId,
    fromDate,
    toDate
  );

  logger.info(`📥 Found ${finologTransactions.length} Finolog transactions`);

  // Собираем ID всех текущих транзакций из Finolog
  const currentFinologTxIds = new Set(finologTransactions.map(tx => tx.id));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const finologTx of finologTransactions) {
    try {
      // Нормализуем дату
      const date = finolog.normalizeDate(finologTx.date);

      // Проверяем дату (только с 1 января 2026)
      if (date < config.syncStartDate) {
        logger.debug(`Skipping transaction ${finologTx.id} - before sync start date`);
        skipped++;
        continue;
      }

      // Проверяем, существует ли маппинг для этой транзакции
      const existingMapping = await supabase.getFinologMapping(finologAccountId, finologTx.id);

      // Генерируем уникальный import_id
      const importId = finolog.generateImportId(finologTx, finologAccountId);

      // Конвертируем сумму из Finolog milliunits в YNAB milliunits
      const finologMilliunits = finolog.convertToMilliunits(finologTx.value);

      // Конвертируем валюту если нужно
      const ynabAmount = await convertCurrency(
        finologMilliunits,
        finologCurrency,
        ynabCurrency,
        date
      );

      if (ynabAmount === null) {
        logger.warn(`Cannot convert currency for transaction ${finologTx.id} - skipping`);
        errors++;
        continue;
      }

      // Формируем memo с исходной суммой и валютой
      const originalAmount = `${finologTx.value} ${finologCurrency}`;
      const memo = finologTx.description
        ? `${finologTx.description} | ${originalAmount} | Finolog Sync`
        : `${originalAmount} | Finolog Sync`;

      // Определяем знак транзакции
      // Finolog: 'expense'/'out' = расход (отрицательное), 'income'/'in' = доход (положительное)
      const isExpense = finologTx.type === 'expense' || finologTx.type === 'out';
      const finalAmount = isExpense ? -Math.abs(ynabAmount) : Math.abs(ynabAmount);

      // Если маппинг существует - проверяем транзакцию в YNAB
      if (existingMapping) {
        // Проверяем, существует ли транзакция в YNAB
        let ynabTransactionExists = true;
        try {
          const ynabTransactions = await ynab.getAccountTransactions(ynabBudgetId, ynabAccountId);
          const ynabTx = ynabTransactions.find(tx => tx.id === existingMapping.ynab_transaction_id);
          
          if (!ynabTx || ynabTx.deleted) {
            ynabTransactionExists = false;
          }
        } catch (error: any) {
          logger.error(`Error checking YNAB transaction existence:`, error.message);
        }

        // Если транзакция удалена в YNAB - пересоздаем
        if (!ynabTransactionExists) {
          logger.warn(`⚠️  YNAB transaction ${existingMapping.ynab_transaction_id} was manually deleted, recreating...`);
          
          try {
            const ynabTx = await ynab.createTransaction(ynabBudgetId, {
              account_id: ynabAccountId,
              date: date,
              amount: finalAmount,
              memo: memo,
              cleared: 'cleared',
              approved: true,
              import_id: `${importId}:${Date.now().toString().slice(-8)}`,
            });

            // Обновляем маппинг с новым YNAB transaction ID
            await supabase.updateFinologMappingYnabId(
              finologAccountId,
              finologTx.id,
              ynabTx.id,
              finologTx.value,
              date,
              finologTx.description
            );

            created++;
            logger.info(`✅ Recreated YNAB transaction for Finolog TX ${finologTx.id}`);
          } catch (error: any) {
            logger.error(`Error recreating YNAB transaction:`, error.message);
            errors++;
          }
          continue;
        }

        // Транзакция существует - проверяем изменения
        const hasChanged = 
          existingMapping.finolog_amount !== finologTx.value ||
          existingMapping.finolog_date !== date ||
          existingMapping.finolog_description !== finologTx.description;

        if (hasChanged) {
          logger.info(`🔄 Updating YNAB transaction: ${finologTx.id} (${finologTx.type}) - ${finalAmount / 1000} ${ynabCurrency}`);
          
          try {
            await ynab.updateTransaction(
              ynabBudgetId,
              existingMapping.ynab_transaction_id,
              {
                amount: finalAmount,
                date: date,
                memo: memo,
              }
            );

            // Обновляем маппинг с новыми значениями
            await supabase.updateFinologMapping(
              finologAccountId,
              finologTx.id,
              finologTx.value,
              date,
              finologTx.description
            );

            updated++;
            logger.info(`✅ Updated YNAB transaction for Finolog TX ${finologTx.id}`);
          } catch (error: any) {
            logger.error(`Error updating YNAB transaction ${existingMapping.ynab_transaction_id}:`, error.message);
            errors++;
          }
        } else {
          logger.debug(`Transaction ${finologTx.id} unchanged, skipping`);
          skipped++;
        }
        continue;
      }

      // Маппинга нет - создаем новую транзакцию
      logger.info(`📝 Creating YNAB transaction: ${finologTx.id} (${finologTx.type}) - ${finalAmount / 1000} ${ynabCurrency}`);

      let currentImportId = importId;

      try {
        const ynabTx = await ynab.createTransaction(ynabBudgetId, {
          account_id: ynabAccountId,
          date: date,
          amount: finalAmount,
          memo: memo,
          cleared: 'cleared',
          approved: true,
          import_id: currentImportId,
        });
        
        // Сохраняем маппинг
        await supabase.createFinologMapping(
          finologAccountId,
          finologTx.id,
          ynabBudgetId,
          ynabAccountId,
          ynabTx.id,
          finologTx.value,
          date,
          finologTx.description
        );
        
        created++;
        logger.info(`✅ Created YNAB transaction for Finolog TX ${finologTx.id}`);
      } catch (createError: any) {
        // Если ошибка 409 (import_id уже существует), пробуем с timestamp
        if (createError.message && createError.message.includes('409')) {
          logger.warn(`⚠️  Import ID conflict for ${importId}, retrying with unique timestamp...`);
          
          // Используем только последние 8 цифр timestamp для краткости (max 36 chars)
          const timestamp = Date.now().toString().slice(-8);
          currentImportId = `${importId}:${timestamp}`;
          
          try {
            const ynabTx = await ynab.createTransaction(ynabBudgetId, {
              account_id: ynabAccountId,
              date: date,
              amount: finalAmount,
              memo: memo,
              cleared: 'cleared',
              approved: true,
              import_id: currentImportId,
            });
            
            // Сохраняем маппинг
            await supabase.createFinologMapping(
              finologAccountId,
              finologTx.id,
              ynabBudgetId,
              ynabAccountId,
              ynabTx.id,
              finologTx.value,
              date,
              finologTx.description
            );
            
            created++;
            logger.info(`✅ Created YNAB transaction for Finolog TX ${finologTx.id} with unique import_id: ${currentImportId}`);
          } catch (retryError: any) {
            // Если и с timestamp не удалось - транзакция уже существует, пропускаем
            if (retryError.message && retryError.message.includes('409')) {
              logger.debug(`Transaction ${finologTx.id} already exists, skipping`);
              skipped++;
            } else {
              throw retryError;
            }
          }
        } else {
          throw createError;
        }
      }

    } catch (error: any) {
      logger.error(`Error processing Finolog transaction ${finologTx.id}:`, error.message);
      errors++;
    }
  }

  // Обрабатываем удаленные транзакции
  logger.debug(`🔍 Checking for deleted Finolog transactions...`);
  const deleted = await handleDeletedFinologTransactions(accountConfig, currentFinologTxIds);

  logger.info(`✅ Finolog sync completed for account ${finologAccountId}: Created ${created}, Updated ${updated}, Skipped ${skipped}, Deleted ${deleted}, Errors ${errors}`);
}

/**
 * Главная функция синхронизации Finolog → YNAB
 */
export async function syncFinologToYnab(): Promise<{ created: number; updated: number; skipped: number; deleted: number; errors: number }> {
  if (!finolog.isConfigured()) {
    logger.info('Finolog sync disabled - no API token configured');
    return { created: 0, updated: 0, skipped: 0, deleted: 0, errors: 0 };
  }

  if (EPIC_WEB3_CONFIG.length === 0) {
    logger.warn('⚠️ Finolog sync disabled - no accounts configured in EPIC_WEB3_CONFIG');
    return { created: 0, updated: 0, skipped: 0, deleted: 0, errors: 0 };
  }

  logger.info('🚀 Starting Finolog → YNAB synchronization');

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalDeleted = 0;
  let totalErrors = 0;

  for (const accountConfig of EPIC_WEB3_CONFIG) {
    try {
      await syncFinologAccount(accountConfig);
      // TODO: Collect stats from syncFinologAccount
    } catch (error: any) {
      logger.error(`Error syncing Finolog account ${accountConfig.finologAccountId}:`, error.message);
      totalErrors++;
    }
  }

  logger.info('✅ Finolog → YNAB synchronization completed');
  
  return { created: totalCreated, updated: totalUpdated, skipped: totalSkipped, deleted: totalDeleted, errors: totalErrors };
}

