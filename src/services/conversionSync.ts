import { ynab } from '../clients/ynab.js';
import { supabase } from '../clients/supabase.js';
import { logger } from '../utils/logger.js';
import { convertEurToUsd, convertGbpToUsd, formatAmount } from './currency.js';

/**
 * Конфигурация аккаунта для конвертации валют
 */
interface ConversionAccount {
  id: string;
  budget_id: string;
  account_id: string;
  source_currency: string; // EUR, RUB, SGD
  target_currency: string; // USD, EUR
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Результат синхронизации конвертации
 */
interface ConversionSyncResult {
  accountId: string;
  budgetId: string;
  converted: number;
  skipped: number;
  errors: number;
  details: string[];
}

/**
 * Конвертирует сумму между валютами
 */
async function convertAmount(
  amount: number,
  date: string,
  sourceCurrency: string,
  targetCurrency: string
): Promise<number | null> {
  const conversionKey = `${sourceCurrency}_to_${targetCurrency}`;

  // EUR -> USD
  if (sourceCurrency === 'EUR' && targetCurrency === 'USD') {
    return await convertEurToUsd(amount, date);
  }

  // GBP -> USD
  if (sourceCurrency === 'GBP' && targetCurrency === 'USD') {
    return await convertGbpToUsd(amount, date);
  }

  // Для других пар можно добавить позже
  logger.warn(`Unsupported conversion: ${conversionKey}`);
  return null;
}

/**
 * Проверяет, нужна ли конвертация для транзакции
 * Транзакция считается неконвертированной, если в memo нет паттерна "XXX EUR" или "XXX RUB"
 */
function needsConversion(memo: string | null | undefined, sourceCurrency: string): boolean {
  if (!memo) return true;

  // Проверяем наличие паттерна типа "123.45 EUR" или "-50.00 RUB"
  const pattern = new RegExp(`-?\\d+(\\.\\d+)?\\s*${sourceCurrency}`, 'i');
  return !pattern.test(memo);
}

/**
 * Форматирует memo с добавлением исходной суммы
 */
function formatMemoWithOriginal(
  existingMemo: string | null | undefined,
  originalAmount: number,
  sourceCurrency: string
): string {
  const originalStr = formatAmount(originalAmount, sourceCurrency as any);

  if (!existingMemo || existingMemo.trim() === '') {
    return originalStr;
  }

  return `${originalStr} | ${existingMemo}`;
}

/**
 * Синхронизирует транзакции одного аккаунта
 */
async function syncConversionAccount(
  account: ConversionAccount,
  sinceDate: string
): Promise<ConversionSyncResult> {
  const result: ConversionSyncResult = {
    accountId: account.account_id,
    budgetId: account.budget_id,
    converted: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  logger.info(`💱 Processing conversion for account ${account.account_id} (${account.source_currency} → ${account.target_currency})`);

  try {
    // Получаем транзакции аккаунта
    const transactions = await ynab.getAccountTransactions(
      account.budget_id,
      account.account_id,
      sinceDate
    );

    logger.info(`Found ${transactions.length} transactions since ${sinceDate}`);

    for (const tx of transactions) {
      // Пропускаем удаленные транзакции
      if (tx.deleted) {
        continue;
      }

      // Пропускаем транзакции которые уже конвертированы
      if (!needsConversion(tx.memo, account.source_currency)) {
        result.skipped++;
        continue;
      }

      // Сохраняем оригинальную сумму до конвертации
      const originalAmount = tx.amount;

      // Конвертируем сумму
      const convertedAmount = await convertAmount(
        originalAmount,
        tx.date,
        account.source_currency,
        account.target_currency
      );

      if (convertedAmount === null) {
        logger.warn(`Failed to convert transaction ${tx.id}: no exchange rate for ${tx.date}`);
        result.errors++;
        result.details.push(`Failed: ${tx.id} - no exchange rate for ${tx.date}`);
        continue;
      }

      // Форматируем новый memo
      const newMemo = formatMemoWithOriginal(tx.memo, originalAmount, account.source_currency);

      logger.info(`Converting transaction ${tx.id}: original=${originalAmount}, converted=${convertedAmount}, memo="${newMemo}"`);

      // Обновляем транзакцию в YNAB
      const updated = await ynab.updateTransaction(account.budget_id, tx.id, {
        amount: convertedAmount,
        memo: newMemo,
      });

      logger.info(`YNAB update result: ${updated ? `success, new amount=${updated.amount}` : 'failed'}`);

      if (updated) {
        result.converted++;
        const originalFormatted = formatAmount(originalAmount, account.source_currency as any);
        const convertedFormatted = formatAmount(convertedAmount, account.target_currency as any);
        logger.info(`Converted: ${tx.payee_name || 'Unknown'} ${originalFormatted} → ${convertedFormatted}`);
        result.details.push(`Converted: ${tx.payee_name || tx.id} ${originalFormatted} → ${convertedFormatted}`);
      } else {
        result.errors++;
        result.details.push(`Failed to update: ${tx.id}`);
      }
    }

  } catch (error) {
    logger.error(`Error syncing conversion account ${account.account_id}:`, error);
    result.errors++;
    result.details.push(`Error: ${String(error)}`);
  }

  return result;
}

/**
 * Основная функция синхронизации конвертации всех аккаунтов
 */
export async function syncConversionAccounts(): Promise<{
  success: boolean;
  results: ConversionSyncResult[];
  totalConverted: number;
  totalSkipped: number;
  totalErrors: number;
}> {
  logger.info('💱 Starting currency conversion sync...');

  const results: ConversionSyncResult[] = [];
  let totalConverted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  try {
    // Получаем активные аккаунты для конвертации
    const accounts = await supabase.getConversionAccounts();

    if (accounts.length === 0) {
      logger.info('No conversion accounts configured');
      return {
        success: true,
        results: [],
        totalConverted: 0,
        totalSkipped: 0,
        totalErrors: 0,
      };
    }

    logger.info(`Found ${accounts.length} conversion account(s)`);

    // Дата начала синхронизации - начало текущего месяца
    const now = new Date();
    const sinceDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    for (const account of accounts) {
      const result = await syncConversionAccount(account, sinceDate);
      results.push(result);
      totalConverted += result.converted;
      totalSkipped += result.skipped;
      totalErrors += result.errors;
    }

    logger.info(`💱 Conversion sync completed: ${totalConverted} converted, ${totalSkipped} skipped, ${totalErrors} errors`);

    return {
      success: totalErrors === 0,
      results,
      totalConverted,
      totalSkipped,
      totalErrors,
    };

  } catch (error) {
    logger.error('Currency conversion sync failed:', error);
    return {
      success: false,
      results,
      totalConverted,
      totalSkipped,
      totalErrors: totalErrors + 1,
    };
  }
}
