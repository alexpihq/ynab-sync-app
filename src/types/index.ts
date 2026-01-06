// YNAB API Types (основные, которые нам нужны)
export interface YnabTransaction {
  id: string;
  date: string; // ISO format: YYYY-MM-DD
  amount: number; // milliunits (1 EUR = 1000)
  memo: string | null;
  cleared: 'cleared' | 'uncleared' | 'reconciled';
  approved: boolean;
  flag_color: string | null;
  account_id: string;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
  matched_transaction_id: string | null;
  import_id: string | null;
  deleted: boolean;
}

export interface YnabTransactionDetail extends YnabTransaction {
  account_name: string;
  subtransactions: YnabSubTransaction[];
}

export interface YnabSubTransaction {
  id: string;
  transaction_id: string;
  amount: number;
  memo: string | null;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  transfer_account_id: string | null;
  deleted: boolean;
}

export interface YnabTransactionsResponse {
  data: {
    transactions: YnabTransactionDetail[];
    server_knowledge: number;
  };
}

export interface YnabAccount {
  id: string;
  name: string;
  type: string;
  on_budget: boolean;
  closed: boolean;
  balance: number;
  cleared_balance: number;
  uncleared_balance: number;
  transfer_payee_id: string;
  deleted: boolean;
}

// Database Types
export interface BudgetConfig {
  budget_id: string;
  budget_name: string;
  budget_type: 'personal' | 'company';
  currency: 'EUR' | 'USD';
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface LoanAccount {
  id: string;
  company_budget_id: string;
  company_name: string;
  personal_account_id: string;
  personal_account_name: string;
  company_account_id: string;
  company_account_name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ExchangeRate {
  month: string; // YYYY-MM
  eur_to_usd: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface TransactionMapping {
  id: string;
  company_budget_id: string;
  personal_tx_id: string | null;
  company_tx_id: string | null;
  personal_amount: number; // milliunits
  company_amount: number; // milliunits
  exchange_rate: number;
  transaction_date: string; // YYYY-MM-DD
  source_budget: 'personal' | 'company';
  sync_status: 'active' | 'deleted' | 'error';
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncState {
  budget_id: string;
  last_server_knowledge: number;
  last_sync_at: string | null;
  last_sync_status: 'success' | 'error' | 'running';
  last_error_message: string | null;
  transactions_synced: number;
  updated_at: string;
}

export interface SyncLogEntry {
  id: string;
  sync_run_id: string;
  budget_id: string | null;
  action: 'create' | 'update' | 'delete' | 'skip' | 'error';
  transaction_id: string | null;
  mirror_transaction_id: string | null;
  details: Record<string, any> | null;
  error_message: string | null;
  created_at: string;
}

// Config Types
export interface AppConfig {
  ynabToken: string;
  finologApiToken: string; // Optional - for Epic Web3 Finolog sync
  aspireProxyUrl: string; // Optional - for Aspire Bank Innerly sync
  tronWalletAddress: string; // Optional - for Tron USDT Innerly sync
  tronApiKey: string; // Optional - for Tron USDT Innerly sync
  supabaseUrl: string;
  supabaseServiceKey: string;
  personalBudgetId: string;
  innerlyBudgetId: string;
  vibeconBudgetId: string;
  syncIntervalMinutes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  syncStartDate: string; // YYYY-MM-DD
}

// Sync Types
export interface SyncContext {
  runId: string;
  startTime: Date;
  budgetId: string;
  budgetName: string;
}

export interface SyncResult {
  success: boolean;
  transactionsProcessed: number;
  transactionsCreated: number;
  transactionsUpdated: number;
  transactionsSkipped: number;
  errors: string[];
}

export interface TransactionSyncDetail {
  transactionId: string;
  date: string;
  amount: number;
  payee: string | null;
  account: string;
  budget: string;
  action: 'created' | 'updated' | 'skipped' | 'deleted' | 'error';
  mirrorId?: string;
  details?: string;
}

