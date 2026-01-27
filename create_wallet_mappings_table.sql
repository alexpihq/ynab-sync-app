-- Create wallet_mappings table for Zerion sync
CREATE TABLE IF NOT EXISTS wallet_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL,
  wallet_name TEXT,
  budget_id TEXT NOT NULL,
  budget_name TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_name TEXT,
  budget_currency TEXT NOT NULL DEFAULT 'USD',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create unique index on wallet_address
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_mappings_address ON wallet_mappings(wallet_address);

-- Enable RLS
ALTER TABLE wallet_mappings ENABLE ROW LEVEL SECURITY;

-- Create policy for service role
CREATE POLICY "Service role can do everything" ON wallet_mappings
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Insert existing wallets
INSERT INTO wallet_mappings (wallet_address, wallet_name, budget_id, budget_name, account_id, budget_currency) VALUES
  ('0x82F52BdE8c4b744af3a55d81a76959f7df8B0dAa', 'Wallet 0x82F5...0dAa', '9c2dd1ba-36c2-4cb9-9428-6882160a155a', 'Epic Web3', '293d7299-4969-4601-9f33-a6b37a2ebf12', 'USD'),
  ('0xFB4F73630e8a83C2645D11aaA51Ee09a10C33a56', 'Wallet 0xFB4F...3a56', '9c2dd1ba-36c2-4cb9-9428-6882160a155a', 'Epic Web3', 'c155d736-bf9b-4fb1-8f40-a790b3ec945a', 'USD'),
  ('0x68d03371748986A897D7999a8CB40E044c05BA54', 'Wallet 0x68d0...BA54', '9c2dd1ba-36c2-4cb9-9428-6882160a155a', 'Epic Web3', '4898adfe-7f9b-47f7-8d8f-f6f7e5a58580', 'USD'),
  ('0xda4a77521F05DC0671FF2944D1Fb14ee0E4977a3', 'Wallet 0xda4a...77a3', '9c2dd1ba-36c2-4cb9-9428-6882160a155a', 'Epic Web3', '37c3fc45-1cd2-42cf-8a9a-ab0f9b579cb8', 'USD'),
  ('0xE0A5Ae83365b2BeE7869324E378310D566f8f77c', 'Wallet 0xE0A5...f77c', '9c2dd1ba-36c2-4cb9-9428-6882160a155a', 'Epic Web3', 'a9166321-9603-44c4-a0f4-52d1441aabfd', 'USD'),
  ('DF9GjZHdtvtrtJYDg7Bn1voCfbW3FCoYQigkqx9XYFKb', 'Solana Wallet DF9G...YFKb', '9c2dd1ba-36c2-4cb9-9428-6882160a155a', 'Epic Web3', '2f993c81-d81d-4315-9cbe-ffb61dc04bf6', 'USD'),
  ('0x029cB45ef8f6Dcd8191f8Ce238730983E47b2a08', 'Wallet 0x029c...2a08', '90024622-dd15-4ef9-bfad-4e555f5471ac', 'Alex Budget', '3d852d5c-0dce-4050-b4ba-39f1241b7677', 'EUR'),
  ('0x479624417561A1B53F508c41409AdEDd8cEDbaaf', 'Wallet 0x4796...baaf', '6dd20115-3f86-44d8-9dfa-911c699034dc', 'Innerly Budget', '3fea31dc-a371-42b2-95fe-46d7956e9def', 'USD')
ON CONFLICT (wallet_address) DO NOTHING;
