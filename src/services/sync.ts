import { randomUUID } from 'crypto';
import { ynab } from '../clients/ynab.js';
import { supabase } from '../clients/supabase.js';
import { logger } from '../utils/logger.js';
import { config, BUDGETS, COMPANIES } from '../config/index.js';
import { convertEurToUsd, convertUsdToEur, formatAmount } from './currency.js';
import {
  YnabTransactionDetail,
  SyncContext,
  LoanAccount,
  TransactionSyncDetail,
} from '../types/index.js';

/**
 * Основной класс для синхронизации займов между бюджетами
 */
export class SyncService {
  /**
   * Helper для создания записи о транзакции
   */
  private createTransactionDetail(
    transaction: YnabTransactionDetail,
    budget: string,
    action: TransactionSyncDetail['action'],
    mirrorId?: string,
    details?: string
  ): TransactionSyncDetail {
    return {
      transactionId: transaction.id,
      date: transaction.date,
      amount: transaction.amount,
      payee: transaction.payee_name,
      account: transaction.account_name,
      budget,
      action,
      mirrorId,
      details
    };
  }
  /**
   * Запускает один цикл синхронизации для всех бюджетов
   */
  async runSyncCycle(): Promise<{ created: number; updated: number; skipped: number; errors: number; processed: number; transactions: TransactionSyncDetail[] }> {
    const cycleId = randomUUID();
    logger.info(`\n========== Starting sync cycle ${cycleId} ==========`);

    let totalCreated = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let totalProcessed = 0;
    const allTransactions: TransactionSyncDetail[] = [];

    try {
      // Синхронизация личный → компании
      const personalStats = await this.syncPersonalToCompanies(cycleId);
      totalCreated += personalStats.created;
      totalUpdated += personalStats.updated;
      totalSkipped += personalStats.skipped;
      totalErrors += personalStats.errors;
      totalProcessed += personalStats.processed;
      allTransactions.push(...personalStats.transactions);

      // Синхронизация компании → личный
      for (const company of COMPANIES) {
        const companyStats = await this.syncCompanyToPersonal(cycleId, company.id, company.name);
        totalCreated += companyStats.created;
        totalUpdated += companyStats.updated;
        totalSkipped += companyStats.skipped;
        totalErrors += companyStats.errors;
        totalProcessed += companyStats.processed;
        allTransactions.push(...companyStats.transactions);
      }

      logger.info(`========== Sync cycle ${cycleId} completed ==========\n`);
      
      // Читаем детальные логи из Supabase
      const syncLogs = await supabase.getSyncLogs(cycleId);
      logger.info(`📋 Fetched ${syncLogs.length} sync log entries for cycle ${cycleId}`);
      
      const transactionDetails = await this.convertLogsToDetails(syncLogs);
      logger.info(`📊 Converted to ${transactionDetails.length} transaction details`);
      
      allTransactions.push(...transactionDetails);
      
    } catch (error) {
      logger.error(`Sync cycle ${cycleId} failed:`, error);
      totalErrors++;
    }

    const result = {
      created: totalCreated,
      updated: totalUpdated,
      skipped: totalSkipped,
      errors: totalErrors,
      processed: totalProcessed,
      transactions: allTransactions
    };
    
    logger.info(`🎯 Final result:`, JSON.stringify({
      ...result,
      transactions: `${result.transactions.length} items`
    }));
    
    return result;
  }

  /**
   * Преобразует логи из Supabase в детали транзакций
   */
  private async convertLogsToDetails(logs: any[]): Promise<TransactionSyncDetail[]> {
    const details: TransactionSyncDetail[] = [];

    for (const log of logs) {
      // Пропускаем общие error логи без transaction_id
      if (!log.transaction_id) continue;

      const action = this.mapActionToDetailAction(log.action);
      const logDetails = log.details || {};

      details.push({
        transactionId: log.transaction_id,
        date: logDetails.date || 'N/A',
        amount: logDetails.amount || 0,
        payee: logDetails.payee || 'N/A',
        account: logDetails.account || 'N/A',
        budget: logDetails.budget || 'N/A',
        action,
        mirrorId: log.mirror_transaction_id || undefined,
        details: log.error_message || logDetails.details || undefined
      });
    }

    return details;
  }

  /**
   * Преобразует action из sync_log в action для TransactionSyncDetail
   */
  private mapActionToDetailAction(action: string): TransactionSyncDetail['action'] {
    switch (action) {
      case 'create': return 'created';
      case 'update': return 'updated';
      case 'skip': return 'skipped';
      case 'delete': return 'deleted';
      case 'error': return 'error';
      default: return 'skipped';
    }
  }

  /**
   * Синхронизирует транзакции из личного бюджета в компании
   */
  private async syncPersonalToCompanies(cycleId: string): Promise<{ created: number; updated: number; skipped: number; errors: number; processed: number; transactions: TransactionSyncDetail[] }> {
    const context: SyncContext = {
      runId: cycleId,
      startTime: new Date(),
      budgetId: BUDGETS.PERSONAL.id,
      budgetName: BUDGETS.PERSONAL.name,
    };

    logger.info(`Syncing ${context.budgetName} → Companies...`);
    
    const transactions: TransactionSyncDetail[] = [];

    try {
      // Получаем состояние синхронизации
      const syncState = await supabase.getSyncState(context.budgetId);
      if (!syncState) {
        throw new Error(`Sync state not found for budget ${context.budgetId}`);
      }

      // Обновляем статус на "running"
      await supabase.updateSyncState(context.budgetId, {
        last_sync_status: 'running',
      });

      // Получаем транзакции из YNAB (только изменения с последней синхронизации)
      const { transactions, serverKnowledge } = await ynab.getTransactions(
        context.budgetId,
        config.syncStartDate,
        syncState.last_server_knowledge
      );

      logger.info(`Fetched ${transactions.length} transactions from ${context.budgetName}`);

      // Получаем информацию о loan accounts
      const loanAccounts = await supabase.getLoanAccounts();

      let processed = 0;
      let created = 0;
      let skipped = 0;
      const errors: string[] = [];

      // Обрабатываем каждую транзакцию
      for (const transaction of transactions) {
        if (transaction.deleted) {
          // Проверяем есть ли mapping для этой транзакции
          const existingMapping = await supabase.getTransactionMapping(transaction.id);
          if (existingMapping) {
            // Есть mapping - обрабатываем удаление
            await this.handleDeletedTransaction(context, transaction, 'personal');
            processed++;
          } else {
            // Нет mapping - это старая транзакция, игнорируем
            logger.debug(`Deleted transaction ${transaction.id} has no mapping, skipping`);
            skipped++;
          }
          continue;
        }

        // Проверяем, является ли это транзакцией займа
        const loanAccount = loanAccounts.find(
          la => la.personal_account_id === transaction.account_id
        );

        if (!loanAccount) {
          // Не транзакция займа - пропускаем
          skipped++;
          continue;
        }

        // Проверяем, не является ли это зеркальной транзакцией (по import_id)
        if (transaction.import_id?.startsWith('LOAN:')) {
          // Это зеркало - проверяем, не изменили ли его вручную
          const existingMapping = await supabase.getTransactionMapping(transaction.id);
          if (existingMapping) {
            const hasChanged = await this.handleMirrorUpdate(context, transaction, existingMapping, 'personal');
            if (hasChanged) {
              processed++;
            } else {
              skipped++;
            }
          } else {
            skipped++;
          }
          continue;
        }

        // Проверяем, не синхронизирована ли уже эта транзакция
        const existingMapping = await supabase.getTransactionMapping(transaction.id);
        if (existingMapping) {
          // Транзакция уже синхронизирована - проверяем изменения
          const hasChanged = await this.handleSourceUpdate(context, transaction, existingMapping, loanAccount, 'personal');
          if (hasChanged) {
            processed++;
          } else {
            skipped++;
          }
          continue;
        }

        // Создаем зеркальную транзакцию в компании
        const success = await this.createMirrorTransaction(
          context,
          transaction,
          loanAccount,
          'personal'
        );

        if (success) {
          created++;
        } else {
          errors.push(`Failed to mirror transaction ${transaction.id}`);
        }

        processed++;
      }

      // Обновляем состояние синхронизации
      await supabase.updateSyncState(context.budgetId, {
        last_server_knowledge: serverKnowledge,
        last_sync_at: new Date().toISOString(),
        last_sync_status: errors.length > 0 ? 'error' : 'success',
        last_error_message: errors.length > 0 ? errors.join('; ') : null,
        transactions_synced: (syncState.transactions_synced || 0) + created,
      });

      logger.info(`${context.budgetName} sync completed:`, {
        processed,
        created,
        skipped,
        errors: errors.length,
      });

      return { created, updated: 0, skipped, errors: errors.length, processed, transactions: [] };

    } catch (error: any) {
      logger.error(`Error syncing ${context.budgetName}:`, error);
      
      await supabase.updateSyncState(context.budgetId, {
        last_sync_status: 'error',
        last_error_message: error.message,
      });

      await supabase.logSync({
        sync_run_id: context.runId,
        budget_id: context.budgetId,
        action: 'error',
        transaction_id: null,
        mirror_transaction_id: null,
        details: null,
        error_message: error.message,
      });

      return { created: 0, updated: 0, skipped: 0, errors: 1, processed: 0, transactions: [] };
    }
  }

  /**
   * Синхронизирует транзакции из компании в личный бюджет
   */
  private async syncCompanyToPersonal(
    cycleId: string,
    companyBudgetId: string,
    companyName: string
  ): Promise<{ created: number; updated: number; skipped: number; errors: number; processed: number }> {
    const context: SyncContext = {
      runId: cycleId,
      startTime: new Date(),
      budgetId: companyBudgetId,
      budgetName: companyName,
    };

    logger.info(`Syncing ${companyName} → Personal...`);

    try {
      const syncState = await supabase.getSyncState(context.budgetId);
      if (!syncState) {
        throw new Error(`Sync state not found for budget ${context.budgetId}`);
      }

      await supabase.updateSyncState(context.budgetId, {
        last_sync_status: 'running',
      });

      const { transactions, serverKnowledge } = await ynab.getTransactions(
        context.budgetId,
        config.syncStartDate,
        syncState.last_server_knowledge
      );

      logger.info(`Fetched ${transactions.length} transactions from ${companyName}`);

      const loanAccounts = await supabase.getLoanAccounts();

      let processed = 0;
      let created = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const transaction of transactions) {
        if (transaction.deleted) {
          // Проверяем есть ли mapping для этой транзакции
          const existingMapping = await supabase.getTransactionMapping(undefined, transaction.id);
          if (existingMapping) {
            // Есть mapping - обрабатываем удаление
            await this.handleDeletedTransaction(context, transaction, 'company');
            processed++;
          } else {
            // Нет mapping - это старая транзакция, игнорируем
            logger.debug(`Deleted transaction ${transaction.id} has no mapping, skipping`);
            skipped++;
          }
          continue;
        }

        const loanAccount = loanAccounts.find(
          la => la.company_account_id === transaction.account_id &&
                la.company_budget_id === companyBudgetId
        );

        if (!loanAccount) {
          skipped++;
          continue;
        }

        if (transaction.import_id?.startsWith('LOAN:')) {
          // Это зеркало - проверяем, не изменили ли его вручную
          const existingMapping = await supabase.getTransactionMapping(undefined, transaction.id);
          if (existingMapping) {
            const hasChanged = await this.handleMirrorUpdate(context, transaction, existingMapping, 'company');
            if (hasChanged) {
              processed++;
            } else {
              skipped++;
            }
          } else {
            skipped++;
          }
          continue;
        }

        const existingMapping = await supabase.getTransactionMapping(undefined, transaction.id);
        if (existingMapping) {
          // Транзакция уже синхронизирована - проверяем изменения
          const hasChanged = await this.handleSourceUpdate(context, transaction, existingMapping, loanAccount, 'company');
          if (hasChanged) {
            processed++;
          } else {
            skipped++;
          }
          continue;
        }

        const success = await this.createMirrorTransaction(
          context,
          transaction,
          loanAccount,
          'company'
        );

        if (success) {
          created++;
        } else {
          errors.push(`Failed to mirror transaction ${transaction.id}`);
        }

        processed++;
      }

      await supabase.updateSyncState(context.budgetId, {
        last_server_knowledge: serverKnowledge,
        last_sync_at: new Date().toISOString(),
        last_sync_status: errors.length > 0 ? 'error' : 'success',
        last_error_message: errors.length > 0 ? errors.join('; ') : null,
        transactions_synced: (syncState.transactions_synced || 0) + created,
      });

      logger.info(`${companyName} sync completed:`, {
        processed,
        created,
        skipped,
        errors: errors.length,
      });

      return { created, updated: 0, skipped, errors: errors.length, processed, transactions: [] };

    } catch (error: any) {
      logger.error(`Error syncing ${companyName}:`, error);
      
      await supabase.updateSyncState(context.budgetId, {
        last_sync_status: 'error',
        last_error_message: error.message,
      });

      await supabase.logSync({
        sync_run_id: context.runId,
        budget_id: context.budgetId,
        action: 'error',
        transaction_id: null,
        mirror_transaction_id: null,
        details: null,
        error_message: error.message,
      });

      return { created: 0, updated: 0, skipped: 0, errors: 1, processed: 0, transactions: [] };
    }
  }

  /**
   * Создает зеркальную транзакцию
   */
  private async createMirrorTransaction(
    context: SyncContext,
    sourceTx: YnabTransactionDetail,
    loanAccount: LoanAccount,
    sourceType: 'personal' | 'company',
    isRecreation: boolean = false
  ): Promise<boolean> {
    try {
      logger.info(`Creating mirror transaction for ${sourceTx.id}...`);

      // Определяем направление
      const isPersonalToCompany = sourceType === 'personal';
      const targetBudgetId = isPersonalToCompany 
        ? loanAccount.company_budget_id 
        : BUDGETS.PERSONAL.id;
      
      const targetAccountId = isPersonalToCompany
        ? loanAccount.company_account_id
        : loanAccount.personal_account_id;

      // Конвертируем сумму
      let mirrorAmount: number | null;
      let exchangeRate: number | null;

      if (isPersonalToCompany) {
        // EUR → USD
        mirrorAmount = await convertEurToUsd(sourceTx.amount, sourceTx.date);
        const month = sourceTx.date.substring(0, 7);
        exchangeRate = await supabase.getExchangeRate(month);
      } else {
        // USD → EUR
        mirrorAmount = await convertUsdToEur(sourceTx.amount, sourceTx.date);
        const month = sourceTx.date.substring(0, 7);
        exchangeRate = await supabase.getExchangeRate(month);
      }

      if (mirrorAmount === null || exchangeRate === null) {
        logger.error(`Cannot convert amount for transaction ${sourceTx.id} - missing exchange rate`);
        return false;
      }

      // Инвертируем знак (доход ↔ расход)
      mirrorAmount = -mirrorAmount;

      // Формируем import_id для идемпотентности (max 36 символов в YNAB)
      const uuid = sourceTx.id.replace(/-/g, ''); // убираем дефисы (32 символа)
      const sourcePrefix = sourceType === 'personal' ? 'P' : 'C';
      
      let importId: string;
      if (isRecreation) {
        // При пересоздании добавляем timestamp для уникальности
        // Формат: LOAN:P:first12chars:timestamp6 = LOAN:P:xxxxxxxxxxxx:yyyyyy (~30 символов)
        const shortId = uuid.substring(0, 12);
        const timestamp = Date.now().toString(36).slice(-6); // последние 6 символов base36
        importId = `LOAN:${sourcePrefix}:${shortId}:${timestamp}`;
      } else {
        // Обычное создание - детерминированный import_id
        // Формат: LOAN:P:first16chars+last8chars = 31 символ
        const shortId = uuid.substring(0, 16) + uuid.substring(24); // 24 символа
        importId = `LOAN:${sourcePrefix}:${shortId}`;
      }

      // Формируем memo - просто копируем из исходной транзакции + "| Sync"
      const memo = sourceTx.memo 
        ? `${sourceTx.memo} | Sync`
        : 'Loan Sync';

      // Payee оставляем пустым (undefined) - YNAB сам создаст/предложит
      const payeeName = undefined;

      // Создаем транзакцию в YNAB
      const mirrorTx = await ynab.createTransaction(targetBudgetId, {
        account_id: targetAccountId,
        date: sourceTx.date,
        amount: mirrorAmount,
        payee_name: payeeName,
        memo: memo.substring(0, 500), // YNAB limit
        cleared: 'cleared',
        approved: true,
        import_id: importId,
      });

      if (!mirrorTx) {
        logger.error(`Failed to create mirror transaction in YNAB`);
        return false;
      }

      // Сохраняем mapping в БД
      const mapping = await supabase.createTransactionMapping({
        company_budget_id: loanAccount.company_budget_id,
        personal_tx_id: isPersonalToCompany ? sourceTx.id : mirrorTx.id,
        company_tx_id: isPersonalToCompany ? mirrorTx.id : sourceTx.id,
        personal_amount: isPersonalToCompany ? sourceTx.amount : mirrorAmount,
        company_amount: isPersonalToCompany ? mirrorAmount : sourceTx.amount,
        exchange_rate: exchangeRate,
        transaction_date: sourceTx.date,
        source_budget: sourceType,
        sync_status: 'active',
        error_message: null,
      });

      if (!mapping) {
        logger.error(`Failed to create transaction mapping in database - this may be a duplicate`);
        logger.info(`Mirror transaction was created in YNAB but mapping failed. Transaction IDs:`, {
          source: sourceTx.id,
          mirror: mirrorTx.id,
        });
        // Не возвращаем false, так как транзакция уже создана в YNAB
        // При следующем запуске она будет пропущена как уже существующая
      }

      // Логируем успех
      await supabase.logSync({
        sync_run_id: context.runId,
        budget_id: context.budgetId,
        action: 'create',
        transaction_id: sourceTx.id,
        mirror_transaction_id: mirrorTx.id,
        details: {
          date: sourceTx.date,
          amount: sourceTx.amount,
          payee: sourceTx.payee_name,
          account: sourceTx.account_name,
          budget: context.budgetName,
          source_amount: sourceTx.amount,
          mirror_amount: mirrorAmount,
          exchange_rate: exchangeRate,
          loan_account: loanAccount.company_name,
        },
        error_message: null,
      });

      const sourceCurrency = isPersonalToCompany ? 'EUR' : 'USD';
      const targetCurrency = isPersonalToCompany ? 'USD' : 'EUR';

      logger.info(`✅ Created mirror transaction:`, {
        source: sourceTx.id,
        mirror: mirrorTx.id,
        sourceAmount: formatAmount(sourceTx.amount, sourceCurrency as any),
        mirrorAmount: formatAmount(mirrorAmount, targetCurrency as any),
        rate: exchangeRate,
      });

      return true;

    } catch (error: any) {
      logger.error(`Error creating mirror transaction:`, error);
      
      await supabase.logSync({
        sync_run_id: context.runId,
        budget_id: context.budgetId,
        action: 'error',
        transaction_id: sourceTx.id,
        mirror_transaction_id: null,
        details: { error: error.message },
        error_message: error.message,
      });

      return false;
    }
  }

  /**
   * Обрабатывает изменения в ИСХОДНОЙ транзакции
   */
  private async handleSourceUpdate(
    context: SyncContext,
    transaction: YnabTransactionDetail,
    mapping: any,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _loanAccount: LoanAccount,
    sourceType: 'personal' | 'company'
  ): Promise<boolean> {
    try {
      // Сравниваем текущие данные с сохраненными в mapping
      const currentAmount = transaction.amount;
      const currentDate = transaction.date;

      const savedAmount = sourceType === 'personal' 
        ? mapping.personal_amount 
        : mapping.company_amount;
      const savedDate = mapping.transaction_date;

      // Проверяем изменились ли критичные поля
      const amountChanged = currentAmount !== savedAmount;
      const dateChanged = currentDate !== savedDate;

      if (!amountChanged && !dateChanged) {
        // Ничего не изменилось
        logger.debug(`Transaction ${transaction.id} unchanged`);
        return false;
      }

      logger.info(`Source transaction ${transaction.id} was modified - updating mirror`);
      logger.debug(`Changes: amount=${amountChanged}, date=${dateChanged}`);

      // Получаем ID зеркальной транзакции
      const mirrorTxId = sourceType === 'personal' 
        ? mapping.company_tx_id 
        : mapping.personal_tx_id;
      
      const mirrorBudgetId = sourceType === 'personal'
        ? mapping.company_budget_id
        : BUDGETS.PERSONAL.id;

      if (!mirrorTxId || !mirrorBudgetId) {
        logger.error(`Cannot update mirror - missing IDs`);
        return false;
      }

      // Пересчитываем сумму с новым курсом (на случай если дата изменилась)
      const isPersonalToCompany = sourceType === 'personal';
      let newMirrorAmount: number | null;
      let exchangeRate: number | null;

      if (isPersonalToCompany) {
        newMirrorAmount = await convertEurToUsd(currentAmount, currentDate);
        const month = currentDate.substring(0, 7);
        exchangeRate = await supabase.getExchangeRate(month);
      } else {
        newMirrorAmount = await convertUsdToEur(currentAmount, currentDate);
        const month = currentDate.substring(0, 7);
        exchangeRate = await supabase.getExchangeRate(month);
      }

      if (newMirrorAmount === null || exchangeRate === null) {
        logger.error(`Cannot convert amount - missing exchange rate for ${currentDate}`);
        return false;
      }

      // Инвертируем знак
      newMirrorAmount = -newMirrorAmount;

      // Формируем новое memo
      const newMemo = transaction.memo 
        ? `${transaction.memo} | Sync`
        : 'Loan Sync';

      // Обновляем зеркальную транзакцию в YNAB
      const updated = await ynab.updateTransaction(mirrorBudgetId, mirrorTxId, {
        date: currentDate,
        amount: newMirrorAmount,
        memo: newMemo.substring(0, 500),
      });

      if (!updated) {
        logger.error(`Failed to update mirror transaction ${mirrorTxId}`);
        return false;
      }

      // Обновляем mapping в БД
      await supabase.updateTransactionMapping(mapping.id, {
        personal_amount: isPersonalToCompany ? currentAmount : newMirrorAmount,
        company_amount: isPersonalToCompany ? newMirrorAmount : currentAmount,
        exchange_rate: exchangeRate,
        transaction_date: currentDate,
      });

      logger.info(`✅ Updated mirror transaction ${mirrorTxId}`);

      await supabase.logSync({
        sync_run_id: context.runId,
        budget_id: context.budgetId,
        action: 'update',
        transaction_id: transaction.id,
        mirror_transaction_id: mirrorTxId,
        details: { 
          reason: 'source_updated',
          changes: { amountChanged, dateChanged },
        },
        error_message: null,
      });

      return true;

    } catch (error: any) {
      logger.error(`Error handling source update:`, error);
      return false;
    }
  }

  /**
   * Обрабатывает изменения в ЗЕРКАЛЬНОЙ транзакции (восстанавливает из исходной)
   */
  private async handleMirrorUpdate(
    context: SyncContext,
    transaction: YnabTransactionDetail,
    mapping: any,
    sourceType: 'personal' | 'company'
  ): Promise<boolean> {
    try {
      // Получаем данные исходной транзакции из mapping
      const isSourcePersonal = mapping.source_budget === 'personal';
      const sourceTxId = isSourcePersonal 
        ? mapping.personal_tx_id 
        : mapping.company_tx_id;
      
      const sourceBudgetId = isSourcePersonal
        ? BUDGETS.PERSONAL.id
        : mapping.company_budget_id;

      // Проверяем изменилась ли зеркальная транзакция
      const currentAmount = transaction.amount;
      const currentDate = transaction.date;

      const savedAmount = sourceType === 'personal' 
        ? mapping.personal_amount 
        : mapping.company_amount;
      const savedDate = mapping.transaction_date;

      const amountChanged = currentAmount !== savedAmount;
      const dateChanged = currentDate !== savedDate;

      if (!amountChanged && !dateChanged) {
        // Зеркало не менялось
        logger.debug(`Mirror transaction ${transaction.id} unchanged`);
        return false;
      }

      logger.info(`Mirror transaction ${transaction.id} was modified manually - restoring from source`);
      logger.debug(`Changes detected: amount=${amountChanged}, date=${dateChanged}`);

      // Получаем исходную транзакцию из YNAB
      const sourceTx = await ynab.getTransaction(sourceBudgetId, sourceTxId);
      
      if (!sourceTx || sourceTx.deleted) {
        logger.warn(`Source transaction ${sourceTxId} not found - cannot restore mirror`);
        return false;
      }

      // Пересчитываем правильную сумму из исходной
      let correctMirrorAmount: number | null;
      let exchangeRate: number | null;

      if (isSourcePersonal) {
        // Источник EUR → зеркало USD
        correctMirrorAmount = await convertEurToUsd(sourceTx.amount, sourceTx.date);
        const month = sourceTx.date.substring(0, 7);
        exchangeRate = await supabase.getExchangeRate(month);
      } else {
        // Источник USD → зеркало EUR
        correctMirrorAmount = await convertUsdToEur(sourceTx.amount, sourceTx.date);
        const month = sourceTx.date.substring(0, 7);
        exchangeRate = await supabase.getExchangeRate(month);
      }

      if (correctMirrorAmount === null || exchangeRate === null) {
        logger.error(`Cannot convert amount - missing exchange rate`);
        return false;
      }

      // Инвертируем знак
      correctMirrorAmount = -correctMirrorAmount;

      // Формируем memo из исходной
      const correctMemo = sourceTx.memo 
        ? `${sourceTx.memo} | Sync`
        : 'Loan Sync';

      // Восстанавливаем зеркало к правильному состоянию
      const mirrorBudgetId = sourceType === 'personal'
        ? BUDGETS.PERSONAL.id
        : mapping.company_budget_id;

      const updated = await ynab.updateTransaction(mirrorBudgetId, transaction.id, {
        date: sourceTx.date,
        amount: correctMirrorAmount,
        memo: correctMemo.substring(0, 500),
      });

      if (!updated) {
        logger.error(`Failed to restore mirror transaction ${transaction.id}`);
        return false;
      }

      logger.info(`✅ Restored mirror transaction ${transaction.id} from source`);

      await supabase.logSync({
        sync_run_id: context.runId,
        budget_id: context.budgetId,
        action: 'update',
        transaction_id: transaction.id,
        mirror_transaction_id: sourceTxId,
        details: { 
          reason: 'mirror_restored',
          changes: { amountChanged, dateChanged },
        },
        error_message: null,
      });

      return true;

    } catch (error: any) {
      logger.error(`Error handling mirror update:`, error);
      return false;
    }
  }

  /**
   * Обрабатывает удаленную транзакцию
   */
  private async handleDeletedTransaction(
    context: SyncContext,
    transaction: YnabTransactionDetail,
    sourceType: 'personal' | 'company'
  ): Promise<void> {
    logger.info(`Handling deleted transaction ${transaction.id}`);

    try {
      // Проверяем, является ли это зеркальной транзакцией
      const isMirrorTransaction = transaction.import_id?.startsWith('LOAN:');

      if (isMirrorTransaction) {
        // Это зеркальная транзакция, удаленная вручную - нужно пересоздать!
        logger.info(`Mirror transaction ${transaction.id} was deleted manually - will recreate`);
        
        // Находим mapping
        const mapping = sourceType === 'personal'
          ? await supabase.getTransactionMapping(transaction.id)
          : await supabase.getTransactionMapping(undefined, transaction.id);

        if (!mapping) {
          logger.warn(`No mapping found for deleted mirror transaction ${transaction.id}`);
          return;
        }

        // Получаем исходную транзакцию
        // Смотрим на mapping.source_budget чтобы понять где исходная транзакция
        const isSourcePersonal = mapping.source_budget === 'personal';
        const sourceTxId = isSourcePersonal 
          ? mapping.personal_tx_id 
          : mapping.company_tx_id;
        
        const sourceBudgetId = isSourcePersonal
          ? BUDGETS.PERSONAL.id
          : mapping.company_budget_id;

        if (!sourceTxId || !sourceBudgetId) {
          logger.warn(`Cannot recreate - missing source transaction info`);
          return;
        }

        // Получаем исходную транзакцию из YNAB
        const sourceTx = await ynab.getTransaction(sourceBudgetId, sourceTxId);
        
        if (!sourceTx || sourceTx.deleted) {
          logger.info(`Source transaction ${sourceTxId} is also deleted - not recreating`);
          
          // Обновляем mapping
          await supabase.updateTransactionMapping(mapping.id, {
            sync_status: 'deleted',
          });
          return;
        }

        // Исходная транзакция существует - пересоздаём зеркало
        logger.info(`Source transaction exists - recreating mirror`);

        // Получаем loan account для пересоздания
        // Используем account_id из исходной транзакции
        const loanAccount = isSourcePersonal
          ? await supabase.getLoanAccountByPersonalAccountId(sourceTx.account_id)
          : await supabase.getLoanAccountByCompanyAccountId(sourceTx.account_id);

        if (!loanAccount) {
          logger.error(`Loan account not found for recreating mirror`);
          return;
        }

        // Пересчитываем сумму (может курс изменился)
        const isPersonalToCompany = mapping.source_budget === 'personal';
        let mirrorAmount: number | null;
        let exchangeRate: number | null;

        if (isPersonalToCompany) {
          mirrorAmount = await convertEurToUsd(sourceTx.amount, sourceTx.date);
          const month = sourceTx.date.substring(0, 7);
          exchangeRate = await supabase.getExchangeRate(month);
        } else {
          mirrorAmount = await convertUsdToEur(sourceTx.amount, sourceTx.date);
          const month = sourceTx.date.substring(0, 7);
          exchangeRate = await supabase.getExchangeRate(month);
        }

        if (mirrorAmount === null || exchangeRate === null) {
          logger.error(`Cannot convert amount - missing exchange rate`);
          return;
        }

        mirrorAmount = -mirrorAmount;

        // Формируем новый import_id с timestamp
        const uuid = sourceTx.id.replace(/-/g, '');
        const sourcePrefix = mapping.source_budget === 'personal' ? 'P' : 'C';
        const shortId = uuid.substring(0, 12);
        const timestamp = Date.now().toString(36).slice(-6);
        const importId = `LOAN:${sourcePrefix}:${shortId}:${timestamp}`;

        // Формируем memo
        const memo = sourceTx.memo 
          ? `${sourceTx.memo} | Sync`
          : 'Loan Sync';

        // Создаём транзакцию в YNAB
        const targetBudgetId = isPersonalToCompany 
          ? loanAccount.company_budget_id 
          : BUDGETS.PERSONAL.id;
        
        const targetAccountId = isPersonalToCompany
          ? loanAccount.company_account_id
          : loanAccount.personal_account_id;

        const newMirrorTx = await ynab.createTransaction(targetBudgetId, {
          account_id: targetAccountId,
          date: sourceTx.date,
          amount: mirrorAmount,
          payee_name: undefined,
          memo: memo.substring(0, 500),
          cleared: 'cleared',
          approved: true,
          import_id: importId,
        });

        if (!newMirrorTx) {
          logger.error(`Failed to recreate mirror transaction in YNAB`);
          return;
        }

        // Обновляем существующий mapping с новым company_tx_id
        await supabase.updateTransactionMapping(mapping.id, {
          company_tx_id: isPersonalToCompany ? newMirrorTx.id : mapping.company_tx_id,
          personal_tx_id: isPersonalToCompany ? mapping.personal_tx_id : newMirrorTx.id,
          personal_amount: isPersonalToCompany ? sourceTx.amount : mirrorAmount,
          company_amount: isPersonalToCompany ? mirrorAmount : sourceTx.amount,
          exchange_rate: exchangeRate,
          transaction_date: sourceTx.date,
          sync_status: 'active',  // Возвращаем в active
        });

        logger.info(`✅ Successfully recreated mirror transaction: ${newMirrorTx.id}`);

        await supabase.logSync({
          sync_run_id: context.runId,
          budget_id: context.budgetId,
          action: 'create',
          transaction_id: transaction.id,
          mirror_transaction_id: sourceTxId,
          details: { reason: 'mirror_deleted_recreated' },
          error_message: null,
        });

      } else {
        // Это исходная транзакция удалена - удаляем зеркало (старая логика)
        logger.info(`Source transaction ${transaction.id} deleted - deleting mirror`);
        
        const mapping = sourceType === 'personal'
          ? await supabase.getTransactionMapping(transaction.id)
          : await supabase.getTransactionMapping(undefined, transaction.id);

        if (!mapping) {
          logger.debug(`No mapping found for deleted transaction ${transaction.id}`);
          return;
        }

        // Удаляем зеркальную транзакцию
        const mirrorTxId = sourceType === 'personal' 
          ? mapping.company_tx_id 
          : mapping.personal_tx_id;
        
        const mirrorBudgetId = sourceType === 'personal'
          ? mapping.company_budget_id
          : BUDGETS.PERSONAL.id;

        if (mirrorTxId && mirrorBudgetId) {
          await ynab.deleteTransaction(mirrorBudgetId, mirrorTxId);
          logger.info(`Deleted mirror transaction ${mirrorTxId}`);
        }

        // Обновляем mapping
        await supabase.updateTransactionMapping(mapping.id, {
          sync_status: 'deleted',
        });

        await supabase.logSync({
          sync_run_id: context.runId,
          budget_id: context.budgetId,
          action: 'delete',
          transaction_id: transaction.id,
          mirror_transaction_id: mirrorTxId || null,
          details: null,
          error_message: null,
        });
      }

    } catch (error: any) {
      logger.error(`Error handling deleted transaction:`, error);
    }
  }
}

export const syncService = new SyncService();

