-- Create TBank transaction mappings table
-- This table stores the mapping between TBank operations and YNAB transactions

CREATE TABLE IF NOT EXISTS tbank_transaction_mappings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  
  -- TBank operation details
  tbank_account_number TEXT NOT NULL,
  tbank_operation_id TEXT NOT NULL,
  tbank_operation_date TIMESTAMPTZ NOT NULL,
  tbank_amount NUMERIC(15,2) NOT NULL,
  tbank_currency TEXT NOT NULL, -- RUB, USD, GBP, EUR
  
  -- YNAB transaction details
  ynab_budget_id TEXT NOT NULL,
  ynab_account_id TEXT NOT NULL,
  ynab_transaction_id TEXT NOT NULL,
  
  -- Sync metadata
  sync_status TEXT NOT NULL DEFAULT 'active', -- active, deleted, error
  error_message TEXT,
  
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Constraints
  CONSTRAINT unique_tbank_operation UNIQUE (tbank_account_number, tbank_operation_id),
  CONSTRAINT valid_sync_status CHECK (sync_status IN ('active', 'deleted', 'error'))
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_tbank_mappings_account_status 
  ON tbank_transaction_mappings (tbank_account_number, sync_status);

CREATE INDEX IF NOT EXISTS idx_tbank_mappings_operation_id 
  ON tbank_transaction_mappings (tbank_operation_id);

CREATE INDEX IF NOT EXISTS idx_tbank_mappings_ynab_transaction 
  ON tbank_transaction_mappings (ynab_budget_id, ynab_transaction_id);

CREATE INDEX IF NOT EXISTS idx_tbank_mappings_operation_date 
  ON tbank_transaction_mappings (tbank_operation_date DESC);

-- Create updated_at trigger
CREATE OR REPLACE FUNCTION update_tbank_mappings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tbank_mappings_updated_at
  BEFORE UPDATE ON tbank_transaction_mappings
  FOR EACH ROW
  EXECUTE FUNCTION update_tbank_mappings_updated_at();

-- Add comments
COMMENT ON TABLE tbank_transaction_mappings IS 'Маппинг между операциями TBank и транзакциями YNAB';
COMMENT ON COLUMN tbank_transaction_mappings.tbank_account_number IS 'Номер счета ТБанка (20 цифр)';
COMMENT ON COLUMN tbank_transaction_mappings.tbank_operation_id IS 'ID операции из TBank API (UUID)';
COMMENT ON COLUMN tbank_transaction_mappings.tbank_operation_date IS 'Дата операции в TBank';
COMMENT ON COLUMN tbank_transaction_mappings.tbank_amount IS 'Сумма операции в валюте счета';
COMMENT ON COLUMN tbank_transaction_mappings.tbank_currency IS 'Валюта операции (RUB, USD, GBP, EUR)';
COMMENT ON COLUMN tbank_transaction_mappings.sync_status IS 'Статус синхронизации: active, deleted, error';




