-- Create zenmoney_transaction_mappings table for tracking Zenmoney -> YNAB transaction synchronization
CREATE TABLE IF NOT EXISTS public.zenmoney_transaction_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zenmoney_transaction_id TEXT NOT NULL,
  zenmoney_account_id TEXT NOT NULL,
  ynab_budget_id TEXT NOT NULL,
  ynab_account_id TEXT NOT NULL,
  ynab_transaction_id TEXT,
  amount_rub BIGINT NOT NULL,
  amount_eur BIGINT NOT NULL,
  date DATE NOT NULL,
  payee TEXT,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'created', 'updated', 'skipped', 'error')),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Unique constraint to prevent duplicate mappings
  CONSTRAINT unique_zenmoney_transaction UNIQUE (zenmoney_transaction_id, zenmoney_account_id, ynab_budget_id)
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_zenmoney_mappings_transaction_id ON public.zenmoney_transaction_mappings(zenmoney_transaction_id);
CREATE INDEX IF NOT EXISTS idx_zenmoney_mappings_account_id ON public.zenmoney_transaction_mappings(zenmoney_account_id);
CREATE INDEX IF NOT EXISTS idx_zenmoney_mappings_ynab_transaction_id ON public.zenmoney_transaction_mappings(ynab_transaction_id);
CREATE INDEX IF NOT EXISTS idx_zenmoney_mappings_status ON public.zenmoney_transaction_mappings(status);
CREATE INDEX IF NOT EXISTS idx_zenmoney_mappings_date ON public.zenmoney_transaction_mappings(date);

-- Create trigger to automatically update updated_at
CREATE OR REPLACE FUNCTION update_zenmoney_mappings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER zenmoney_mappings_updated_at
BEFORE UPDATE ON public.zenmoney_transaction_mappings
FOR EACH ROW
EXECUTE FUNCTION update_zenmoney_mappings_updated_at();

-- Add comment to table
COMMENT ON TABLE public.zenmoney_transaction_mappings IS 'Tracks Zenmoney to YNAB transaction synchronization for personal accounts';

