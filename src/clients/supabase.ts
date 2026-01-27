import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import {
  BudgetConfig,
  LoanAccount,
  CompanyLoanAccount,
  LinkedTransaction,
  TransactionMapping,
  SyncState,
  SyncLogEntry,
  WalletMappingDB,
} from '../types/index.js';

class SupabaseService {
  public client: SupabaseClient;

  constructor() {
    this.client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: {
        persistSession: false,
      },
    });
    logger.info('Supabase client initialized');
  }

  // ===== Budgets Config =====
  async getBudgetConfig(budgetId: string): Promise<BudgetConfig | null> {
    const { data, error } = await this.client
      .from('budgets_config')
      .select('*')
      .eq('budget_id', budgetId)
      .single();

    if (error) {
      logger.error('Error fetching budget config:', error);
      return null;
    }

    return data;
  }

  // ===== Loan Accounts =====
  async getLoanAccounts(): Promise<LoanAccount[]> {
    const { data, error } = await this.client
      .from('loan_accounts')
      .select('*')
      .eq('is_active', true);

    if (error) {
      logger.error('Error fetching loan accounts:', error);
      return [];
    }

    return data || [];
  }

  async getLoanAccountByPersonalAccountId(accountId: string): Promise<LoanAccount | null> {
    const { data, error } = await this.client
      .from('loan_accounts')
      .select('*')
      .eq('personal_account_id', accountId)
      .eq('is_active', true)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows
      logger.error('Error fetching loan account:', error);
    }

    return data;
  }

  async getLoanAccountByCompanyAccountId(accountId: string): Promise<LoanAccount | null> {
    const { data, error } = await this.client
      .from('loan_accounts')
      .select('*')
      .eq('company_account_id', accountId)
      .eq('is_active', true)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error('Error fetching loan account:', error);
    }

    return data;
  }

  // ===== Exchange Rates =====
  async getExchangeRate(month: string): Promise<number | null> {
    const { data, error } = await this.client
      .from('exchange_rates')
      .select('eur_to_usd')
      .eq('month', month)
      .single();

    if (error) {
      logger.error(`Error fetching exchange rate for ${month}:`, error);
      return null;
    }

    return data?.eur_to_usd || null;
  }

  async getExchangeRates(month: string): Promise<{ eurToUsd: number | null; eurToRub: number | null }> {
    const { data, error } = await this.client
      .from('exchange_rates')
      .select('eur_to_usd, eur_to_rub')
      .eq('month', month)
      .single();

    if (error) {
      logger.error(`Error fetching exchange rates for ${month}:`, error);
      return { eurToUsd: null, eurToRub: null };
    }

    return {
      eurToUsd: data?.eur_to_usd || null,
      eurToRub: data?.eur_to_rub || null,
    };
  }

  async getExchangeRateRub(month: string): Promise<number | null> {
    const { data, error } = await this.client
      .from('exchange_rates')
      .select('eur_to_rub')
      .eq('month', month)
      .single();

    if (error) {
      logger.error(`Error fetching EUR/RUB rate for ${month}:`, error);
      return null;
    }

    return data?.eur_to_rub || null;
  }

  // ===== Transaction Mappings =====
  async getTransactionMapping(
    personalTxId?: string,
    companyTxId?: string
  ): Promise<TransactionMapping | null> {
    let query = this.client.from('transaction_mappings').select('*');

    if (personalTxId) {
      query = query.eq('personal_tx_id', personalTxId);
    } else if (companyTxId) {
      query = query.eq('company_tx_id', companyTxId);
    } else {
      return null;
    }

    const { data, error } = await query.single();

    if (error && error.code !== 'PGRST116') {
      logger.error('Error fetching transaction mapping:', error);
    }

    return data;
  }

  async createTransactionMapping(mapping: Omit<TransactionMapping, 'id' | 'created_at' | 'updated_at'>): Promise<TransactionMapping | null> {
    const { data, error } = await this.client
      .from('transaction_mappings')
      .insert(mapping)
      .select()
      .single();

    if (error) {
      logger.error('Error creating transaction mapping:', error);
      return null;
    }

    return data;
  }

  async updateTransactionMapping(
    id: string,
    updates: Partial<Omit<TransactionMapping, 'id' | 'created_at'>>
  ): Promise<boolean> {
    const { error } = await this.client
      .from('transaction_mappings')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      logger.error('Error updating transaction mapping:', error);
      return false;
    }

    return true;
  }

  // ===== Sync State =====
  async getSyncState(budgetId: string): Promise<SyncState | null> {
    const { data, error } = await this.client
      .from('sync_state')
      .select('*')
      .eq('budget_id', budgetId)
      .single();

    if (error) {
      logger.error('Error fetching sync state:', error);
      return null;
    }

    return data;
  }

  async updateSyncState(
    budgetId: string,
    updates: Partial<Omit<SyncState, 'budget_id'>>
  ): Promise<boolean> {
    const { error } = await this.client
      .from('sync_state')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('budget_id', budgetId);

    if (error) {
      logger.error('Error updating sync state:', error);
      return false;
    }

    return true;
  }

  // ===== Sync Log =====
  async logSync(entry: Omit<SyncLogEntry, 'id' | 'created_at'>): Promise<void> {
    const { error } = await this.client
      .from('sync_log')
      .insert(entry);

    if (error) {
      logger.error('Error logging sync entry:', error);
    }
  }

  async getSyncLogs(syncRunId: string): Promise<SyncLogEntry[]> {
    const { data, error } = await this.client
      .from('sync_log')
      .select('*')
      .eq('sync_run_id', syncRunId)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error('Error fetching sync logs:', error);
      return [];
    }

    return data || [];
  }

  // ===== Finolog Transaction Mappings =====
  async createFinologMapping(
    finologAccountId: number,
    finologTransactionId: number,
    ynabBudgetId: string,
    ynabAccountId: string,
    ynabTransactionId: string,
    finologAmount: number,
    finologDate: string,
    finologDescription: string | null
  ): Promise<void> {
    const { error } = await this.client
      .from('finolog_transaction_mappings')
      .insert({
        finolog_account_id: finologAccountId,
        finolog_transaction_id: finologTransactionId,
        ynab_budget_id: ynabBudgetId,
        ynab_account_id: ynabAccountId,
        ynab_transaction_id: ynabTransactionId,
        finolog_amount: finologAmount,
        finolog_date: finologDate,
        finolog_description: finologDescription,
        sync_status: 'active',
      });

    if (error) {
      logger.error('Error creating Finolog mapping:', error);
    }
  }

  async getFinologMappingsByAccount(finologAccountId: number): Promise<any[]> {
    const { data, error } = await this.client
      .from('finolog_transaction_mappings')
      .select('*')
      .eq('finolog_account_id', finologAccountId)
      .eq('sync_status', 'active');

    if (error) {
      logger.error('Error fetching Finolog mappings:', error);
      return [];
    }

    return data || [];
  }

  async updateFinologMappingStatus(
    finologAccountId: number,
    finologTransactionId: number,
    status: string
  ): Promise<void> {
    const { error } = await this.client
      .from('finolog_transaction_mappings')
      .update({ 
        sync_status: status,
        updated_at: new Date().toISOString()
      })
      .eq('finolog_account_id', finologAccountId)
      .eq('finolog_transaction_id', finologTransactionId);

    if (error) {
      logger.error('Error updating Finolog mapping status:', error);
    }
  }

  async getFinologMapping(
    finologAccountId: number,
    finologTransactionId: number
  ): Promise<any | null> {
    const { data, error } = await this.client
      .from('finolog_transaction_mappings')
      .select('*')
      .eq('finolog_account_id', finologAccountId)
      .eq('finolog_transaction_id', finologTransactionId)
      .eq('sync_status', 'active')
      .single();

    if (error) {
      return null;
    }

    return data;
  }

  async updateFinologMapping(
    finologAccountId: number,
    finologTransactionId: number,
    finologAmount: number,
    finologDate: string,
    finologDescription: string | null
  ): Promise<void> {
    const { error } = await this.client
      .from('finolog_transaction_mappings')
      .update({
        finolog_amount: finologAmount,
        finolog_date: finologDate,
        finolog_description: finologDescription,
        updated_at: new Date().toISOString()
      })
      .eq('finolog_account_id', finologAccountId)
      .eq('finolog_transaction_id', finologTransactionId);

    if (error) {
      logger.error('Error updating Finolog mapping:', error);
    }
  }

  async getExchangeRateSgd(month: string): Promise<number | null> {
    const { data, error} = await this.client
      .from('exchange_rates')
      .select('usd_to_sgd')
      .eq('month', month)
      .single();

    if (error) {
      logger.error(`Error fetching USD/SGD rate for ${month}:`, error);
      return null;
    }

    return data?.usd_to_sgd || null;
  }

  async getExchangeRateGbp(month: string): Promise<number | null> {
    const { data, error } = await this.client
      .from('exchange_rates')
      .select('gbp_to_usd')
      .eq('month', month)
      .single();

    if (error) {
      logger.error(`Error fetching GBP/USD rate for ${month}:`, error);
      return null;
    }

    return data?.gbp_to_usd || null;
  }

  // ===== Aspire Transaction Mappings =====
  async createAspireMapping(
    aspireAccountId: string,
    aspireTransactionId: string,
    aspireDatetime: string,
    ynabBudgetId: string,
    ynabAccountId: string,
    ynabTransactionId: string,
    aspireAmount: number,
    aspireCurrency: string,
    aspireReference: string | null
  ): Promise<void> {
    const { error } = await this.client
      .from('aspire_transaction_mappings')
      .insert({
        aspire_account_id: aspireAccountId,
        aspire_transaction_id: aspireTransactionId,
        aspire_datetime: aspireDatetime,
        ynab_budget_id: ynabBudgetId,
        ynab_account_id: ynabAccountId,
        ynab_transaction_id: ynabTransactionId,
        aspire_amount: aspireAmount,
        aspire_currency: aspireCurrency,
        aspire_reference: aspireReference,
        sync_status: 'active',
      });

    if (error) {
      logger.error('Error creating Aspire mapping:', error);
    }
  }

  async getAspireMappingsByAccount(aspireAccountId: string): Promise<any[]> {
    const { data, error } = await this.client
      .from('aspire_transaction_mappings')
      .select('*')
      .eq('aspire_account_id', aspireAccountId)
      .eq('sync_status', 'active');

    if (error) {
      logger.error('Error fetching Aspire mappings:', error);
      return [];
    }

    return data || [];
  }

  async getAspireMapping(
    aspireAccountId: string,
    aspireTransactionId: string
  ): Promise<any | null> {
    const { data, error } = await this.client
      .from('aspire_transaction_mappings')
      .select('*')
      .eq('aspire_account_id', aspireAccountId)
      .eq('aspire_transaction_id', aspireTransactionId)
      .eq('sync_status', 'active')
      .single();

    if (error) {
      return null;
    }

    return data;
  }

  async updateAspireMappingStatus(
    aspireAccountId: string,
    aspireTransactionId: string,
    status: string
  ): Promise<void> {
    const { error } = await this.client
      .from('aspire_transaction_mappings')
      .update({
        sync_status: status,
        updated_at: new Date().toISOString()
      })
      .eq('aspire_account_id', aspireAccountId)
      .eq('aspire_transaction_id', aspireTransactionId);

    if (error) {
      logger.error('Error updating Aspire mapping status:', error);
    }
  }

  async updateAspireMappingYnabId(
    aspireAccountId: string,
    aspireTransactionId: string,
    ynabTransactionId: string,
    aspireAmount: number,
    aspireDatetime: string,
    aspireReference: string | null
  ): Promise<void> {
    const { error } = await this.client
      .from('aspire_transaction_mappings')
      .update({
        ynab_transaction_id: ynabTransactionId,
        aspire_amount: aspireAmount,
        aspire_datetime: aspireDatetime,
        aspire_reference: aspireReference,
        updated_at: new Date().toISOString()
      })
      .eq('aspire_account_id', aspireAccountId)
      .eq('aspire_transaction_id', aspireTransactionId);

    if (error) {
      logger.error('Error updating Aspire mapping YNAB ID:', error);
    }
  }

  // ===== Tron Transaction Mappings =====
  async createTronMapping(
    walletAddress: string,
    transactionId: string,
    blockTs: number,
    direction: string,
    fromAddress: string,
    toAddress: string,
    ynabBudgetId: string,
    ynabAccountId: string,
    ynabTransactionId: string,
    amount: number
  ): Promise<void> {
    const { error } = await this.client
      .from('tron_transaction_mappings')
      .insert({
        tron_wallet_address: walletAddress,
        tron_transaction_id: transactionId,
        tron_block_ts: blockTs,
        tron_direction: direction,
        tron_from_address: fromAddress,
        tron_to_address: toAddress,
        ynab_budget_id: ynabBudgetId,
        ynab_account_id: ynabAccountId,
        ynab_transaction_id: ynabTransactionId,
        tron_amount: amount,
        sync_status: 'active',
      });

    if (error) {
      logger.error('Error creating Tron mapping:', error);
    }
  }

  async getTronMappingsByWallet(walletAddress: string): Promise<any[]> {
    const { data, error } = await this.client
      .from('tron_transaction_mappings')
      .select('*')
      .eq('tron_wallet_address', walletAddress)
      .eq('sync_status', 'active');

    if (error) {
      logger.error('Error fetching Tron mappings:', error);
      return [];
    }

    return data || [];
  }

  async getTronMapping(
    walletAddress: string,
    transactionId: string
  ): Promise<any | null> {
    const { data, error } = await this.client
      .from('tron_transaction_mappings')
      .select('*')
      .eq('tron_wallet_address', walletAddress)
      .eq('tron_transaction_id', transactionId)
      .eq('sync_status', 'active')
      .single();

    if (error) {
      return null;
    }

    return data;
  }

  async updateTronMappingStatus(
    walletAddress: string,
    transactionId: string,
    status: string
  ): Promise<void> {
    const { error } = await this.client
      .from('tron_transaction_mappings')
      .update({
        sync_status: status,
        updated_at: new Date().toISOString()
      })
      .eq('tron_wallet_address', walletAddress)
      .eq('tron_transaction_id', transactionId);

    if (error) {
      logger.error('Error updating Tron mapping status:', error);
    }
  }

  async updateTronMapping(
    walletAddress: string,
    transactionId: string,
    updates: {
      tron_amount?: number;
      tron_block_ts?: number;
      ynab_transaction_id?: string;
    }
  ): Promise<void> {
    const { error } = await this.client
      .from('tron_transaction_mappings')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('tron_wallet_address', walletAddress)
      .eq('tron_transaction_id', transactionId);

    if (error) {
      logger.error('Error updating Tron mapping:', error);
    }
  }

  async updateFinologMappingYnabId(
    finologAccountId: number,
    finologTransactionId: number,
    ynabTransactionId: string,
    finologAmount: number,
    finologDate: string,
    finologDescription: string | null
  ): Promise<void> {
    const { error } = await this.client
      .from('finolog_transaction_mappings')
      .update({
        ynab_transaction_id: ynabTransactionId,
        finolog_amount: finologAmount,
        finolog_date: finologDate,
        finolog_description: finologDescription,
        updated_at: new Date().toISOString()
      })
      .eq('finolog_account_id', finologAccountId)
      .eq('finolog_transaction_id', finologTransactionId);

    if (error) {
      logger.error('Error updating Finolog mapping YNAB ID:', error);
    }
  }

  // ===== TBank Transaction Mappings =====
  async createTbankMapping(
    tbankAccountNumber: string,
    tbankOperationId: string,
    tbankOperationDate: string,
    ynabBudgetId: string,
    ynabAccountId: string,
    ynabTransactionId: string,
    tbankAmount: number,
    tbankCurrency: string
  ): Promise<void> {
    const { error } = await this.client
      .from('tbank_transaction_mappings')
      .insert({
        tbank_account_number: tbankAccountNumber,
        tbank_operation_id: tbankOperationId,
        tbank_operation_date: tbankOperationDate,
        ynab_budget_id: ynabBudgetId,
        ynab_account_id: ynabAccountId,
        ynab_transaction_id: ynabTransactionId,
        tbank_amount: tbankAmount,
        tbank_currency: tbankCurrency,
        sync_status: 'active',
      });

    if (error) {
      logger.error('Error creating TBank mapping:', error);
      throw error;
    }
  }

  async getTbankMappingsByAccount(tbankAccountNumber: string): Promise<any[]> {
    const { data, error } = await this.client
      .from('tbank_transaction_mappings')
      .select('*')
      .eq('tbank_account_number', tbankAccountNumber)
      .eq('sync_status', 'active');

    if (error) {
      logger.error('Error fetching TBank mappings:', error);
      return [];
    }

    return data || [];
  }

  async getTbankMapping(
    tbankAccountNumber: string,
    tbankOperationId: string
  ): Promise<any | null> {
    const { data, error } = await this.client
      .from('tbank_transaction_mappings')
      .select('*')
      .eq('tbank_account_number', tbankAccountNumber)
      .eq('tbank_operation_id', tbankOperationId)
      .eq('sync_status', 'active')
      .single();

    if (error) {
      return null;
    }

    return data;
  }

  async updateTbankMappingStatus(
    tbankAccountNumber: string,
    tbankOperationId: string,
    status: string
  ): Promise<void> {
    const { error } = await this.client
      .from('tbank_transaction_mappings')
      .update({
        sync_status: status,
        updated_at: new Date().toISOString()
      })
      .eq('tbank_account_number', tbankAccountNumber)
      .eq('tbank_operation_id', tbankOperationId);

    if (error) {
      logger.error('Error updating TBank mapping status:', error);
    }
  }

  async updateTbankMappingYnabId(
    tbankAccountNumber: string,
    tbankOperationId: string,
    ynabTransactionId: string,
    tbankAmount: number,
    tbankOperationDate: string
  ): Promise<void> {
    const { error } = await this.client
      .from('tbank_transaction_mappings')
      .update({
        ynab_transaction_id: ynabTransactionId,
        tbank_amount: tbankAmount,
        tbank_operation_date: tbankOperationDate,
        updated_at: new Date().toISOString()
      })
      .eq('tbank_account_number', tbankAccountNumber)
      .eq('tbank_operation_id', tbankOperationId);

    if (error) {
      logger.error('Error updating TBank mapping YNAB ID:', error);
    }
  }

  // ===== Zenmoney Transaction Mappings =====
  async createZenmoneyMapping(
    zenmoneyTransactionId: string,
    zenmoneyAccountId: string,
    ynabBudgetId: string,
    ynabAccountId: string,
    amountRub: number,
    amountEur: number,
    date: string,
    payee: string | null,
    memo: string | null
  ): Promise<void> {
    const { error } = await this.client
      .from('zenmoney_transaction_mappings')
      .insert({
        zenmoney_transaction_id: zenmoneyTransactionId,
        zenmoney_account_id: zenmoneyAccountId,
        ynab_budget_id: ynabBudgetId,
        ynab_account_id: ynabAccountId,
        amount_rub: amountRub,
        amount_eur: amountEur,
        date,
        payee,
        memo,
        status: 'pending'
      });

    if (error) {
      logger.error('Error creating Zenmoney mapping:', error);
      throw error;
    }
  }

  async getZenmoneyMappingsByAccount(
    zenmoneyAccountId: string,
    ynabBudgetId: string
  ): Promise<any[]> {
    const { data, error } = await this.client
      .from('zenmoney_transaction_mappings')
      .select('*')
      .eq('zenmoney_account_id', zenmoneyAccountId)
      .eq('ynab_budget_id', ynabBudgetId);

    if (error) {
      logger.error('Error fetching Zenmoney mappings:', error);
      return [];
    }

    return data || [];
  }

  async getZenmoneyMapping(
    zenmoneyTransactionId: string,
    zenmoneyAccountId: string,
    ynabBudgetId: string
  ): Promise<any | null> {
    const { data, error } = await this.client
      .from('zenmoney_transaction_mappings')
      .select('*')
      .eq('zenmoney_transaction_id', zenmoneyTransactionId)
      .eq('zenmoney_account_id', zenmoneyAccountId)
      .eq('ynab_budget_id', ynabBudgetId)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error('Error fetching Zenmoney mapping:', error);
    }

    return data;
  }

  async updateZenmoneyMappingStatus(
    zenmoneyTransactionId: string,
    zenmoneyAccountId: string,
    ynabBudgetId: string,
    status: string,
    errorMessage?: string
  ): Promise<void> {
    const { error } = await this.client
      .from('zenmoney_transaction_mappings')
      .update({
        status,
        error_message: errorMessage || null,
        updated_at: new Date().toISOString()
      })
      .eq('zenmoney_transaction_id', zenmoneyTransactionId)
      .eq('zenmoney_account_id', zenmoneyAccountId)
      .eq('ynab_budget_id', ynabBudgetId);

    if (error) {
      logger.error('Error updating Zenmoney mapping status:', error);
    }
  }

  async updateZenmoneyMappingYnabId(
    zenmoneyTransactionId: string,
    zenmoneyAccountId: string,
    ynabBudgetId: string,
    ynabTransactionId: string
  ): Promise<void> {
    const { error } = await this.client
      .from('zenmoney_transaction_mappings')
      .update({
        ynab_transaction_id: ynabTransactionId,
        status: 'created',
        updated_at: new Date().toISOString()
      })
      .eq('zenmoney_transaction_id', zenmoneyTransactionId)
      .eq('zenmoney_account_id', zenmoneyAccountId)
      .eq('ynab_budget_id', ynabBudgetId);

    if (error) {
      logger.error('Error updating Zenmoney mapping YNAB ID:', error);
    }
  }

  // ===== Conversion Accounts =====
  async getConversionAccounts(): Promise<any[]> {
    const { data, error } = await this.client
      .from('conversion_accounts')
      .select('*')
      .eq('is_active', true);

    if (error) {
      logger.error('Error fetching conversion accounts:', error);
      return [];
    }

    return data || [];
  }

  async getAllConversionAccounts(): Promise<any[]> {
    const { data, error } = await this.client
      .from('conversion_accounts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching all conversion accounts:', error);
      return [];
    }

    return data || [];
  }

  async getConversionAccount(id: string): Promise<any | null> {
    const { data, error } = await this.client
      .from('conversion_accounts')
      .select('*')
      .eq('id', id)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error('Error fetching conversion account:', error);
    }

    return data;
  }

  async createConversionAccount(
    budgetId: string,
    accountId: string,
    sourceCurrency: string,
    targetCurrency: string
  ): Promise<any | null> {
    const { data, error } = await this.client
      .from('conversion_accounts')
      .insert({
        budget_id: budgetId,
        account_id: accountId,
        source_currency: sourceCurrency,
        target_currency: targetCurrency,
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      logger.error('Error creating conversion account:', error);
      return null;
    }

    return data;
  }

  async updateConversionAccount(
    id: string,
    updates: {
      budget_id?: string;
      account_id?: string;
      source_currency?: string;
      target_currency?: string;
      is_active?: boolean;
    }
  ): Promise<any | null> {
    const { data, error } = await this.client
      .from('conversion_accounts')
      .update({
        ...updates,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Error updating conversion account:', error);
      return null;
    }

    return data;
  }

  async deleteConversionAccount(id: string): Promise<boolean> {
    const { error } = await this.client
      .from('conversion_accounts')
      .delete()
      .eq('id', id);

    if (error) {
      logger.error('Error deleting conversion account:', error);
      return false;
    }

    return true;
  }

  // ===== Company Loan Accounts (Company ↔ Company) =====
  async getCompanyLoanAccounts(): Promise<CompanyLoanAccount[]> {
    const { data, error } = await this.client
      .from('company_loan_accounts')
      .select('*')
      .eq('is_active', true);

    if (error) {
      logger.error('Error fetching company loan accounts:', error);
      return [];
    }

    return data || [];
  }

  async getCompanyLoanAccountByAccountId(accountId: string): Promise<CompanyLoanAccount | null> {
    // Check both sides of the relationship
    const { data, error } = await this.client
      .from('company_loan_accounts')
      .select('*')
      .eq('is_active', true)
      .or(`account_id_1.eq.${accountId},account_id_2.eq.${accountId}`)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error('Error fetching company loan account:', error);
    }

    return data;
  }

  // ===== Linked Transactions =====
  async getLinkedTransaction(transactionId: string): Promise<LinkedTransaction | null> {
    // Check both sides
    const { data, error } = await this.client
      .from('linked_transactions')
      .select('*')
      .or(`transaction_id_1.eq.${transactionId},transaction_id_2.eq.${transactionId}`)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error('Error fetching linked transaction:', error);
    }

    return data;
  }

  async createLinkedTransaction(link: Omit<LinkedTransaction, 'id' | 'created_at' | 'updated_at'>): Promise<LinkedTransaction | null> {
    const { data, error } = await this.client
      .from('linked_transactions')
      .insert(link)
      .select()
      .single();

    if (error) {
      logger.error('Error creating linked transaction:', error);
      return null;
    }

    return data;
  }

  async findMatchingTransaction(
    budgetId: string,
    accountId: string,
    amount: number,
    date: string,
    _dateTolerance: number = 2
  ): Promise<any | null> {
    // Find transactions in the target budget with matching amount and date (±tolerance days)
    // This searches YNAB transactions via the client
    // Returns the first matching transaction or null

    // Note: This is a helper that should be called with YNAB client
    // The actual implementation will be in sync.ts
    logger.debug(`Looking for matching transaction: budget=${budgetId}, account=${accountId}, amount=${amount}, date=${date}`);
    return null; // Placeholder - actual logic in sync.ts
  }

  async isTransactionLinked(transactionId: string): Promise<boolean> {
    const link = await this.getLinkedTransaction(transactionId);
    return link !== null;
  }

  async getAllLinkedTransactions(): Promise<LinkedTransaction[]> {
    const { data, error } = await this.client
      .from('linked_transactions')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching all linked transactions:', error);
      return [];
    }

    return data || [];
  }

  async getLinkedTransactionById(id: string): Promise<LinkedTransaction | null> {
    const { data, error } = await this.client
      .from('linked_transactions')
      .select('*')
      .eq('id', id)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error('Error fetching linked transaction by id:', error);
    }

    return data;
  }

  async updateLinkedTransaction(
    id: string,
    updates: Partial<Omit<LinkedTransaction, 'id' | 'created_at'>>
  ): Promise<LinkedTransaction | null> {
    const { data, error } = await this.client
      .from('linked_transactions')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Error updating linked transaction:', error);
      return null;
    }

    return data;
  }

  async deleteLinkedTransaction(id: string): Promise<boolean> {
    const { error } = await this.client
      .from('linked_transactions')
      .delete()
      .eq('id', id);

    if (error) {
      logger.error('Error deleting linked transaction:', error);
      return false;
    }

    return true;
  }

  // ===== Loan Accounts CRUD =====
  async getAllLoanAccounts(): Promise<LoanAccount[]> {
    const { data, error } = await this.client
      .from('loan_accounts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching all loan accounts:', error);
      return [];
    }

    return data || [];
  }

  async createLoanAccount(
    loanAccount: Omit<LoanAccount, 'id' | 'created_at' | 'updated_at'>
  ): Promise<LoanAccount | null> {
    const { data, error } = await this.client
      .from('loan_accounts')
      .insert(loanAccount)
      .select()
      .single();

    if (error) {
      logger.error('Error creating loan account:', error);
      return null;
    }

    return data;
  }

  async updateLoanAccount(
    id: string,
    updates: Partial<Omit<LoanAccount, 'id' | 'created_at'>>
  ): Promise<LoanAccount | null> {
    const { data, error } = await this.client
      .from('loan_accounts')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Error updating loan account:', error);
      return null;
    }

    return data;
  }

  async deleteLoanAccount(id: string): Promise<boolean> {
    const { error } = await this.client
      .from('loan_accounts')
      .delete()
      .eq('id', id);

    if (error) {
      logger.error('Error deleting loan account:', error);
      return false;
    }

    return true;
  }

  // ===== Company Loan Accounts CRUD =====
  async getAllCompanyLoanAccounts(): Promise<CompanyLoanAccount[]> {
    const { data, error } = await this.client
      .from('company_loan_accounts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching all company loan accounts:', error);
      return [];
    }

    return data || [];
  }

  async createCompanyLoanAccount(
    loanAccount: Omit<CompanyLoanAccount, 'id' | 'created_at' | 'updated_at'>
  ): Promise<CompanyLoanAccount | null> {
    const { data, error } = await this.client
      .from('company_loan_accounts')
      .insert(loanAccount)
      .select()
      .single();

    if (error) {
      logger.error('Error creating company loan account:', error);
      return null;
    }

    return data;
  }

  async updateCompanyLoanAccount(
    id: string,
    updates: Partial<Omit<CompanyLoanAccount, 'id' | 'created_at'>>
  ): Promise<CompanyLoanAccount | null> {
    const { data, error } = await this.client
      .from('company_loan_accounts')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Error updating company loan account:', error);
      return null;
    }

    return data;
  }

  async deleteCompanyLoanAccount(id: string): Promise<boolean> {
    const { error } = await this.client
      .from('company_loan_accounts')
      .delete()
      .eq('id', id);

    if (error) {
      logger.error('Error deleting company loan account:', error);
      return false;
    }

    return true;
  }

  async deleteTransactionMapping(mappingId: string): Promise<boolean> {
    const { error } = await this.client
      .from('transaction_mappings')
      .delete()
      .eq('id', mappingId);

    if (error) {
      logger.error('Error deleting transaction mapping:', error);
      return false;
    }

    return true;
  }

  async getTransactionMappingByCompanyTxId(companyTxId: string): Promise<TransactionMapping | null> {
    const { data, error } = await this.client
      .from('transaction_mappings')
      .select('*')
      .eq('company_tx_id', companyTxId)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error('Error fetching transaction mapping by company tx id:', error);
    }

    return data;
  }

  async getTransactionMappingByPersonalTxId(personalTxId: string): Promise<TransactionMapping | null> {
    const { data, error } = await this.client
      .from('transaction_mappings')
      .select('*')
      .eq('personal_tx_id', personalTxId)
      .single();

    if (error && error.code !== 'PGRST116') {
      logger.error('Error fetching transaction mapping by personal tx id:', error);
    }

    return data;
  }

  // ===== Wallet Mappings CRUD =====
  async getAllWalletMappings(): Promise<WalletMappingDB[]> {
    const { data, error } = await this.client
      .from('wallet_mappings')
      .select('*')
      .order('budget_name', { ascending: true });

    if (error) {
      logger.error('Error fetching wallet mappings:', error);
      return [];
    }

    return data || [];
  }

  async getActiveWalletMappings(): Promise<WalletMappingDB[]> {
    const { data, error } = await this.client
      .from('wallet_mappings')
      .select('*')
      .eq('is_active', true)
      .order('budget_name', { ascending: true });

    if (error) {
      logger.error('Error fetching active wallet mappings:', error);
      return [];
    }

    return data || [];
  }

  async createWalletMapping(
    mapping: Omit<WalletMappingDB, 'id' | 'created_at' | 'updated_at'>
  ): Promise<WalletMappingDB | null> {
    const { data, error } = await this.client
      .from('wallet_mappings')
      .insert(mapping)
      .select()
      .single();

    if (error) {
      logger.error('Error creating wallet mapping:', error);
      return null;
    }

    return data;
  }

  async updateWalletMapping(
    id: string,
    updates: Partial<Omit<WalletMappingDB, 'id' | 'created_at'>>
  ): Promise<WalletMappingDB | null> {
    const { data, error } = await this.client
      .from('wallet_mappings')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      logger.error('Error updating wallet mapping:', error);
      return null;
    }

    return data;
  }

  async deleteWalletMapping(id: string): Promise<boolean> {
    const { error } = await this.client
      .from('wallet_mappings')
      .delete()
      .eq('id', id);

    if (error) {
      logger.error('Error deleting wallet mapping:', error);
      return false;
    }

    return true;
  }
}

export const supabase = new SupabaseService();

