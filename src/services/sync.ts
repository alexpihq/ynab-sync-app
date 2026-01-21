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
  CompanyLoanAccount,
  TransactionSyncDetail,
} from '../types/index.js';

/**
 * Основной класс для синхронизации займов между бюджетами
 */
export class SyncService {
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
      // ВАЖНО: syncCompanyToCompany должен выполняться ПЕРВЫМ,
      // до того как другие sync'и обновят server_knowledge
      const companyToCompanyStats = await this.syncCompanyToCompany(cycleId);
      totalCreated += companyToCompanyStats.created;
      totalUpdated += companyToCompanyStats.updated;
      totalSkipped += companyToCompanyStats.skipped;
      totalErrors += companyToCompanyStats.errors;
      totalProcessed += companyToCompanyStats.processed;

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

        // Проверяем, не пришла ли уже банковская транзакция, которую мы должны были создать как mirror
        // Это случай дедупликации: bank transfer пришел раньше/позже нашего mirror
        const existingMirror = await this.findExistingMirrorInTarget(
          loanAccount.company_budget_id,
          loanAccount.company_account_id,
          transaction.amount,
          transaction.date,
          'personal'
        );

        if (existingMirror) {
          // Нашли существующий mirror — связываем и удаляем mirror
          logger.info(`Found existing mirror ${existingMirror.id} for bank transaction ${transaction.id}, linking and removing mirror`);

          const linked = await this.linkAndRemoveMirror(
            context,
            transaction,
            existingMirror,
            BUDGETS.PERSONAL.id,
            loanAccount.company_budget_id,
            loanAccount.personal_account_id,
            loanAccount.company_account_id
          );

          if (linked) {
            logger.info(`✅ Deduplication: linked ${transaction.id} ↔ bank tx, removed mirror ${existingMirror.id}`);
            skipped++; // Не создали новый mirror
          } else {
            errors.push(`Failed to deduplicate transaction ${transaction.id}`);
          }
          processed++;
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

        // Проверяем дедупликацию: не пришла ли банковская транзакция в Personal, для которой уже есть mirror
        const existingMirror = await this.findExistingMirrorInTarget(
          BUDGETS.PERSONAL.id,
          loanAccount.personal_account_id,
          transaction.amount,
          transaction.date,
          'company'
        );

        if (existingMirror) {
          // Нашли существующий mirror — связываем и удаляем mirror
          logger.info(`Found existing mirror ${existingMirror.id} for bank transaction ${transaction.id}, linking and removing mirror`);

          const linked = await this.linkAndRemoveMirror(
            context,
            transaction,
            existingMirror,
            companyBudgetId,
            BUDGETS.PERSONAL.id,
            loanAccount.company_account_id,
            loanAccount.personal_account_id
          );

          if (linked) {
            logger.info(`✅ Deduplication: linked ${transaction.id} ↔ bank tx, removed mirror ${existingMirror.id}`);
            skipped++;
          } else {
            errors.push(`Failed to deduplicate transaction ${transaction.id}`);
          }
          processed++;
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

      return { created, updated: 0, skipped, errors: errors.length, processed };

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

      return { created: 0, updated: 0, skipped: 0, errors: 1, processed: 0 };
    }
  }

  /**
   * Синхронизирует транзакции между компаниями (без конвертации валют)
   */
  private async syncCompanyToCompany(
    cycleId: string
  ): Promise<{ created: number; updated: number; skipped: number; errors: number; processed: number }> {
    logger.info(`Syncing Company ↔ Company loans...`);

    let totalCreated = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let totalProcessed = 0;

    try {
      // Получаем все company-to-company loan accounts
      const companyLoanAccounts = await supabase.getCompanyLoanAccounts();

      if (companyLoanAccounts.length === 0) {
        logger.info('No company-to-company loan accounts configured');
        return { created: 0, updated: 0, skipped: 0, errors: 0, processed: 0 };
      }

      logger.info(`Found ${companyLoanAccounts.length} company-to-company loan account pairs`);

      // Для каждой пары компаний синхронизируем в обоих направлениях
      for (const loanAccount of companyLoanAccounts) {
        // Направление 1: Budget1 → Budget2
        const stats1 = await this.syncCompanyPairDirection(
          cycleId,
          loanAccount,
          loanAccount.budget_id_1,
          loanAccount.budget_name_1,
          loanAccount.account_id_1,
          loanAccount.budget_id_2,
          loanAccount.account_id_2
        );
        totalCreated += stats1.created;
        totalUpdated += stats1.updated;
        totalSkipped += stats1.skipped;
        totalErrors += stats1.errors;
        totalProcessed += stats1.processed;

        // Направление 2: Budget2 → Budget1
        const stats2 = await this.syncCompanyPairDirection(
          cycleId,
          loanAccount,
          loanAccount.budget_id_2,
          loanAccount.budget_name_2,
          loanAccount.account_id_2,
          loanAccount.budget_id_1,
          loanAccount.account_id_1
        );
        totalCreated += stats2.created;
        totalUpdated += stats2.updated;
        totalSkipped += stats2.skipped;
        totalErrors += stats2.errors;
        totalProcessed += stats2.processed;
      }

      logger.info(`Company ↔ Company sync completed:`, {
        created: totalCreated,
        updated: totalUpdated,
        skipped: totalSkipped,
        errors: totalErrors,
      });

      return { created: totalCreated, updated: totalUpdated, skipped: totalSkipped, errors: totalErrors, processed: totalProcessed };

    } catch (error: any) {
      logger.error('Error in company-to-company sync:', error);
      return { created: 0, updated: 0, skipped: 0, errors: 1, processed: 0 };
    }
  }

  /**
   * Синхронизирует одно направление для пары компаний
   */
  private async syncCompanyPairDirection(
    cycleId: string,
    loanAccount: CompanyLoanAccount,
    sourceBudgetId: string,
    sourceBudgetName: string,
    sourceAccountId: string,
    targetBudgetId: string,
    targetAccountId: string
  ): Promise<{ created: number; updated: number; skipped: number; errors: number; processed: number }> {
    const context: SyncContext = {
      runId: cycleId,
      startTime: new Date(),
      budgetId: sourceBudgetId,
      budgetName: sourceBudgetName,
    };

    logger.info(`Syncing ${sourceBudgetName} → target company...`);

    try {
      const syncState = await supabase.getSyncState(sourceBudgetId);
      if (!syncState) {
        logger.warn(`Sync state not found for budget ${sourceBudgetId}, skipping`);
        return { created: 0, updated: 0, skipped: 0, errors: 0, processed: 0 };
      }

      // Получаем транзакции из YNAB (используем существующий server_knowledge)
      const { transactions } = await ynab.getTransactions(
        sourceBudgetId,
        config.syncStartDate,
        syncState.last_server_knowledge
      );

      logger.info(`[CC] Fetched ${transactions.length} transactions from ${sourceBudgetName} (sk=${syncState.last_server_knowledge})`);

      let processed = 0;
      let created = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const transaction of transactions) {
        // Пропускаем удалённые
        if (transaction.deleted) {
          logger.debug(`Skipping deleted transaction ${transaction.id}`);
          skipped++;
          continue;
        }

        // Проверяем, принадлежит ли транзакция нужному аккаунту
        if (transaction.account_id !== sourceAccountId) {
          logger.info(`Skipping tx ${transaction.id.slice(0,8)}: account ${transaction.account_id.slice(0,8)} != ${sourceAccountId.slice(0,8)}`);
          skipped++;
          continue;
        }

        // Пропускаем зеркальные транзакции (созданные этим sync)
        if (transaction.import_id?.startsWith('LOAN:')) {
          logger.debug(`Skipping LOAN: mirror transaction ${transaction.id}`);
          skipped++;
          continue;
        }

        // Проверяем, не связана ли уже эта транзакция
        const isLinked = await supabase.isTransactionLinked(transaction.id);
        if (isLinked) {
          logger.debug(`Transaction ${transaction.id} already linked, skipping`);
          skipped++;
          continue;
        }

        // Проверяем существующий mapping
        const existingMapping = await supabase.getTransactionMapping(transaction.id);
        if (existingMapping) {
          // Проверяем, изменилась ли сумма
          const currentAmount = Math.abs(transaction.amount);
          const mappedAmount = Math.abs(existingMapping.personal_amount);

          if (currentAmount !== mappedAmount) {
            // Сумма изменилась — обновляем mirror
            logger.info(`[CC] Amount changed for ${transaction.id.slice(0,8)}: ${mappedAmount/1000} → ${currentAmount/1000}`);

            const mirrorTxId = existingMapping.company_tx_id;
            const newMirrorAmount = -transaction.amount; // Инвертированная сумма

            try {
              await ynab.updateTransaction(targetBudgetId, mirrorTxId, {
                amount: newMirrorAmount
              });

              // Обновляем mapping
              await supabase.updateTransactionMapping(existingMapping.id, {
                personal_amount: transaction.amount,
                company_amount: newMirrorAmount
              });

              logger.info(`✅ [CC] Updated mirror ${mirrorTxId.slice(0,8)}: new amount ${newMirrorAmount/1000}`);
              processed++;
            } catch (error: any) {
              logger.error(`Failed to update mirror for ${transaction.id}:`, error.message);
              errors.push(`Failed to update mirror for ${transaction.id}`);
            }
          } else {
            skipped++;
          }
          continue;
        }

        // Сначала проверяем дедупликацию: не пришла ли bank transaction, когда у нас уже есть LOAN:CC: mirror
        const existingCCMirror = await this.findExistingCompanyMirrorInTarget(
          targetBudgetId,
          targetAccountId,
          transaction.amount,
          transaction.date
        );

        if (existingCCMirror) {
          // Нашли существующий LOAN:CC: mirror — удаляем его, т.к. bank transaction пришла
          logger.info(`Found existing LOAN:CC: mirror ${existingCCMirror.id} for bank tx ${transaction.id}, removing mirror`);

          // Удаляем mirror
          const deleted = await ynab.deleteTransaction(targetBudgetId, existingCCMirror.id);
          if (deleted) {
            logger.info(`✅ Deduplication: removed LOAN:CC: mirror ${existingCCMirror.id}`);
          }

          // Удаляем mapping если есть
          const mirrorMapping = await supabase.getTransactionMappingByCompanyTxId(existingCCMirror.id)
            || await supabase.getTransactionMappingByPersonalTxId(existingCCMirror.id);
          if (mirrorMapping) {
            await supabase.deleteTransactionMapping(mirrorMapping.id);
          }
        }

        // Ищем matching транзакцию в целевом бюджете (auto-linking)
        const matchingTx = await this.findMatchingTransactionInBudget(
          targetBudgetId,
          targetAccountId,
          -transaction.amount, // Инвертированная сумма
          transaction.date
        );

        if (matchingTx) {
          // Нашли matching — связываем вместо создания зеркала
          logger.info(`Found matching transaction ${matchingTx.id} for ${transaction.id}, linking instead of mirroring`);

          await supabase.createLinkedTransaction({
            budget_id_1: sourceBudgetId,
            transaction_id_1: transaction.id,
            account_id_1: sourceAccountId,
            budget_id_2: targetBudgetId,
            transaction_id_2: matchingTx.id,
            account_id_2: targetAccountId,
            amount: Math.abs(transaction.amount),
            transaction_date: transaction.date,
            link_type: 'bank_transfer',
            link_reason: 'Auto-matched by amount and date',
            is_auto_matched: true,
          });

          logger.info(`✅ Linked transactions: ${transaction.id} ↔ ${matchingTx.id}`);
          skipped++; // Считаем как skipped, т.к. зеркало не создали
          processed++;
          continue;
        }

        // Нет matching — создаём зеркальную транзакцию (без конвертации)
        const success = await this.createCompanyMirrorTransaction(
          context,
          transaction,
          loanAccount,
          targetBudgetId,
          targetAccountId
        );

        if (success) {
          created++;
        } else {
          errors.push(`Failed to mirror transaction ${transaction.id}`);
        }

        processed++;
      }

      return { created, updated: 0, skipped, errors: errors.length, processed };

    } catch (error: any) {
      logger.error(`Error syncing company pair direction:`, error);
      return { created: 0, updated: 0, skipped: 0, errors: 1, processed: 0 };
    }
  }

  /**
   * Ищет matching транзакцию в целевом бюджете по сумме и дате
   */
  private async findMatchingTransactionInBudget(
    budgetId: string,
    accountId: string,
    amount: number,
    date: string,
    toleranceDays: number = 2
  ): Promise<YnabTransactionDetail | null> {
    try {
      // Получаем транзакции за последние N дней
      const startDate = new Date(date);
      startDate.setDate(startDate.getDate() - toleranceDays);
      const startDateStr = startDate.toISOString().split('T')[0];

      const { transactions } = await ynab.getTransactions(budgetId, startDateStr);

      // Ищем matching по аккаунту, сумме и дате
      for (const tx of transactions) {
        if (tx.deleted) continue;
        if (tx.account_id !== accountId) continue;
        if (tx.import_id?.startsWith('LOAN:')) continue; // Пропускаем зеркала

        // Проверяем сумму (точное совпадение)
        if (tx.amount !== amount) continue;

        // Проверяем дату (±toleranceDays)
        const txDate = new Date(tx.date);
        const sourceDate = new Date(date);
        const diffDays = Math.abs((txDate.getTime() - sourceDate.getTime()) / (1000 * 60 * 60 * 24));

        if (diffDays <= toleranceDays) {
          // Проверяем, не связана ли уже эта транзакция
          const isLinked = await supabase.isTransactionLinked(tx.id);
          if (!isLinked) {
            return tx;
          }
        }
      }

      return null;
    } catch (error: any) {
      logger.error('Error finding matching transaction:', error);
      return null;
    }
  }

  /**
   * Создает зеркальную транзакцию между компаниями (без конвертации валют)
   */
  private async createCompanyMirrorTransaction(
    context: SyncContext,
    sourceTx: YnabTransactionDetail,
    loanAccount: CompanyLoanAccount,
    targetBudgetId: string,
    targetAccountId: string
  ): Promise<boolean> {
    try {
      logger.info(`Creating company mirror transaction for ${sourceTx.id}...`);

      // Без конвертации — просто инвертируем сумму
      const mirrorAmount = -sourceTx.amount;

      // Формируем import_id
      const uuid = sourceTx.id.replace(/-/g, '');
      const shortId = uuid.substring(0, 16) + uuid.substring(24);
      const importId = `LOAN:CC:${shortId}`; // CC = Company-to-Company

      // Формируем memo
      const memo = sourceTx.memo
        ? `${sourceTx.memo} | Company Sync`
        : 'Company Loan Sync';

      // Создаем транзакцию в YNAB
      const mirrorTx = await ynab.createTransaction(targetBudgetId, {
        account_id: targetAccountId,
        date: sourceTx.date,
        amount: mirrorAmount,
        payee_name: undefined,
        memo: memo.substring(0, 500),
        cleared: 'cleared',
        approved: false,
        import_id: importId,
      });

      if (!mirrorTx) {
        logger.error(`Failed to create company mirror transaction in YNAB`);
        return false;
      }

      // Сохраняем mapping (используем существующую таблицу, но с exchange_rate = 1)
      const mapping = await supabase.createTransactionMapping({
        company_budget_id: targetBudgetId, // Используем target как "company" в mapping
        personal_tx_id: sourceTx.id, // Source transaction
        company_tx_id: mirrorTx.id, // Mirror transaction
        personal_amount: sourceTx.amount,
        company_amount: mirrorAmount,
        exchange_rate: 1, // Нет конвертации
        transaction_date: sourceTx.date,
        source_budget: 'company', // Источник — компания
        sync_status: 'active',
        error_message: null,
      });

      if (!mapping) {
        logger.warn(`Failed to create transaction mapping, but mirror was created`);
      }

      await supabase.logSync({
        sync_run_id: context.runId,
        budget_id: context.budgetId,
        action: 'create',
        transaction_id: sourceTx.id,
        mirror_transaction_id: mirrorTx.id,
        details: {
          type: 'company_to_company',
          source_amount: sourceTx.amount,
          mirror_amount: mirrorAmount,
          loan_account: `${loanAccount.budget_name_1} ↔ ${loanAccount.budget_name_2}`,
        },
        error_message: null,
      });

      logger.info(`✅ Created company mirror transaction:`, {
        source: sourceTx.id,
        mirror: mirrorTx.id,
        amount: formatAmount(mirrorAmount, 'USD'),
      });

      return true;

    } catch (error: any) {
      logger.error(`Error creating company mirror transaction:`, error);
      return false;
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
        approved: false, // Requires manual approval in YNAB
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
          approved: false, // Requires manual approval in YNAB
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

  /**
   * Находит существующую LOAN:CC: транзакцию в целевом бюджете (company-to-company, без конвертации)
   * Используется для дедупликации между компаниями с одинаковой валютой
   */
  private async findExistingCompanyMirrorInTarget(
    targetBudgetId: string,
    targetAccountId: string,
    sourceAmount: number,
    sourceDate: string,
    toleranceDays: number = 2
  ): Promise<YnabTransactionDetail | null> {
    try {
      const startDate = new Date(sourceDate);
      startDate.setDate(startDate.getDate() - toleranceDays);
      const startDateStr = startDate.toISOString().split('T')[0];

      const { transactions } = await ynab.getTransactions(targetBudgetId, startDateStr);

      // Ищем LOAN:CC: mirror с matching суммой (инвертированной) и датой
      const expectedMirrorAmount = -sourceAmount;

      for (const tx of transactions) {
        if (tx.deleted) continue;
        if (tx.account_id !== targetAccountId) continue;
        if (!tx.import_id?.startsWith('LOAN:CC:')) continue; // Только company-to-company mirrors

        // Проверяем сумму (точное совпадение, т.к. нет конвертации)
        if (tx.amount !== expectedMirrorAmount) continue;

        // Проверяем дату (±toleranceDays)
        const txDate = new Date(tx.date);
        const srcDate = new Date(sourceDate);
        const diffDays = Math.abs((txDate.getTime() - srcDate.getTime()) / (1000 * 60 * 60 * 24));

        if (diffDays <= toleranceDays) {
          logger.info(`Found matching LOAN:CC: mirror for deduplication: ${tx.id}, amount=${tx.amount}, date=${tx.date}`);
          return tx;
        }
      }

      return null;
    } catch (error: any) {
      logger.error('Error finding existing company mirror in target:', error);
      return null;
    }
  }

  /**
   * Находит существующую LOAN: транзакцию в целевом бюджете, которая соответствует bank transaction
   * Это нужно для дедупликации: если bank transfer пришел, а у нас уже есть mirror
   */
  private async findExistingMirrorInTarget(
    targetBudgetId: string,
    targetAccountId: string,
    sourceAmount: number,
    sourceDate: string,
    sourceType: 'personal' | 'company',
    toleranceDays: number = 2
  ): Promise<YnabTransactionDetail | null> {
    try {
      // Получаем транзакции из целевого бюджета за период
      const startDate = new Date(sourceDate);
      startDate.setDate(startDate.getDate() - toleranceDays);
      const startDateStr = startDate.toISOString().split('T')[0];

      const { transactions } = await ynab.getTransactions(targetBudgetId, startDateStr);

      // Конвертируем сумму для сравнения (с учетом направления и валюты)
      // Для Personal → Company: EUR → USD
      // Для Company → Personal: USD → EUR
      let expectedMirrorAmount: number | null;

      if (sourceType === 'personal') {
        // Personal (EUR) → Company (USD): конвертируем EUR в USD и инвертируем
        expectedMirrorAmount = await convertEurToUsd(sourceAmount, sourceDate);
        if (expectedMirrorAmount !== null) {
          expectedMirrorAmount = -expectedMirrorAmount;
        }
      } else {
        // Company (USD) → Personal (EUR): конвертируем USD в EUR и инвертируем
        expectedMirrorAmount = await convertUsdToEur(sourceAmount, sourceDate);
        if (expectedMirrorAmount !== null) {
          expectedMirrorAmount = -expectedMirrorAmount;
        }
      }

      if (expectedMirrorAmount === null) {
        logger.warn(`Cannot convert amount for deduplication check, skipping`);
        return null;
      }

      // Ищем LOAN: mirror с matching суммой и датой
      for (const tx of transactions) {
        if (tx.deleted) continue;
        if (tx.account_id !== targetAccountId) continue;
        if (!tx.import_id?.startsWith('LOAN:')) continue; // Ищем только наши mirror

        // Проверяем сумму (с небольшим допуском из-за округления конвертации)
        const amountDiff = Math.abs(tx.amount - expectedMirrorAmount);
        const amountTolerance = Math.abs(expectedMirrorAmount * 0.01); // 1% tolerance
        if (amountDiff > amountTolerance) continue;

        // Проверяем дату (±toleranceDays)
        const txDate = new Date(tx.date);
        const srcDate = new Date(sourceDate);
        const diffDays = Math.abs((txDate.getTime() - srcDate.getTime()) / (1000 * 60 * 60 * 24));

        if (diffDays <= toleranceDays) {
          logger.info(`Found matching LOAN: mirror for deduplication: ${tx.id}, amount=${tx.amount}, date=${tx.date}`);
          return tx;
        }
      }

      return null;
    } catch (error: any) {
      logger.error('Error finding existing mirror in target:', error);
      return null;
    }
  }

  /**
   * Связывает bank transaction с источником и удаляет mirror
   * Это дедупликация: bank transfer пришел → удаляем наш mirror, связываем реальные транзакции
   */
  private async linkAndRemoveMirror(
    context: SyncContext,
    sourceTx: YnabTransactionDetail,
    mirrorTx: YnabTransactionDetail,
    sourceBudgetId: string,
    targetBudgetId: string,
    sourceAccountId: string,
    targetAccountId: string
  ): Promise<boolean> {
    try {
      // 1. Находим mapping для mirror транзакции
      const mapping = await supabase.getTransactionMappingByCompanyTxId(mirrorTx.id)
        || await supabase.getTransactionMappingByPersonalTxId(mirrorTx.id);

      if (!mapping) {
        logger.warn(`No mapping found for mirror ${mirrorTx.id}, cannot deduplicate properly`);
        // Всё равно пробуем создать link
      }

      // 2. Ищем банковскую транзакцию в target budget, которая соответствует source
      // Это транзакция БЕЗ LOAN: prefix с matching суммой
      const { transactions } = await ynab.getTransactions(targetBudgetId, sourceTx.date);

      let bankTxInTarget: YnabTransactionDetail | null = null;
      for (const tx of transactions) {
        if (tx.deleted) continue;
        if (tx.account_id !== targetAccountId) continue;
        if (tx.import_id?.startsWith('LOAN:')) continue; // Пропускаем наши mirror
        if (tx.id === mirrorTx.id) continue;

        // Ищем транзакцию с похожей суммой (инвертированной и конвертированной)
        const amountDiff = Math.abs(tx.amount - mirrorTx.amount);
        const amountTolerance = Math.abs(mirrorTx.amount * 0.02); // 2% tolerance

        if (amountDiff <= amountTolerance) {
          const txDate = new Date(tx.date);
          const srcDate = new Date(sourceTx.date);
          const diffDays = Math.abs((txDate.getTime() - srcDate.getTime()) / (1000 * 60 * 60 * 24));

          if (diffDays <= 3) {
            bankTxInTarget = tx;
            break;
          }
        }
      }

      // 3. Удаляем mirror транзакцию из YNAB
      const deleted = await ynab.deleteTransaction(targetBudgetId, mirrorTx.id);
      if (!deleted) {
        logger.error(`Failed to delete mirror transaction ${mirrorTx.id}`);
        return false;
      }
      logger.info(`Deleted mirror transaction ${mirrorTx.id}`);

      // 4. Удаляем mapping
      if (mapping) {
        await supabase.deleteTransactionMapping(mapping.id);
        logger.info(`Deleted transaction mapping ${mapping.id}`);
      }

      // 5. Создаём link между source и bank transaction в target (если нашли)
      if (bankTxInTarget) {
        await supabase.createLinkedTransaction({
          budget_id_1: sourceBudgetId,
          transaction_id_1: sourceTx.id,
          account_id_1: sourceAccountId,
          budget_id_2: targetBudgetId,
          transaction_id_2: bankTxInTarget.id,
          account_id_2: targetAccountId,
          amount: Math.abs(sourceTx.amount),
          transaction_date: sourceTx.date,
          link_type: 'bank_transfer',
          link_reason: 'Deduplication: bank transfer replaced LOAN mirror',
          is_auto_matched: true,
        });
        logger.info(`Created link: ${sourceTx.id} ↔ ${bankTxInTarget.id}`);
      } else {
        // Если bank transaction не нашли, просто логируем
        logger.info(`Bank transaction not found in target, mirror removed without linking`);
      }

      // 6. Логируем
      await supabase.logSync({
        sync_run_id: context.runId,
        budget_id: context.budgetId,
        action: 'delete',
        transaction_id: sourceTx.id,
        mirror_transaction_id: mirrorTx.id,
        details: {
          reason: 'deduplication',
          bank_tx_found: !!bankTxInTarget,
          bank_tx_id: bankTxInTarget?.id,
        },
        error_message: null,
      });

      return true;

    } catch (error: any) {
      logger.error('Error in linkAndRemoveMirror:', error);
      return false;
    }
  }
}

export const syncService = new SyncService();

