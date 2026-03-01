-- Airwallex Transaction Mappings table
CREATE TABLE IF NOT EXISTS airwallex_transaction_mappings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  airwallex_transaction_id TEXT NOT NULL,
  airwallex_transaction_type TEXT NOT NULL,
  airwallex_datetime TIMESTAMPTZ NOT NULL,
  ynab_budget_id TEXT NOT NULL,
  ynab_account_id TEXT NOT NULL,
  ynab_transaction_id TEXT NOT NULL,
  airwallex_amount DECIMAL(15,2) NOT NULL,
  airwallex_currency TEXT NOT NULL DEFAULT 'USD',
  airwallex_status TEXT NOT NULL,
  airwallex_description TEXT,
  sync_status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_airwallex_tx_id
  ON airwallex_transaction_mappings(airwallex_transaction_id)
  WHERE sync_status = 'active';

CREATE INDEX IF NOT EXISTS idx_airwallex_sync_status
  ON airwallex_transaction_mappings(sync_status);

CREATE INDEX IF NOT EXISTS idx_airwallex_ynab_tx_id
  ON airwallex_transaction_mappings(ynab_transaction_id);
