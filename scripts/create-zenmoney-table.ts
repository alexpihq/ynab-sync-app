import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function createZenmoneyTable() {
  console.log('🔄 Creating zenmoney_transaction_mappings table...');

  // Create table
  const createTableSQL = `
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
      
      CONSTRAINT unique_zenmoney_transaction UNIQUE (zenmoney_transaction_id, zenmoney_account_id, ynab_budget_id)
    );
  `;

  const { error: createError } = await supabase.rpc('exec_sql', { sql: createTableSQL });
  
  if (createError) {
    // Try alternative method - direct query
    const { error: altError } = await supabase.from('zenmoney_transaction_mappings').select('id').limit(1);
    
    if (altError && altError.code === '42P01') {
      console.error('❌ Table does not exist and cannot be created via client.');
      console.log('\n📋 Please run this SQL in Supabase SQL Editor:\n');
      console.log(createTableSQL);
      console.log('\n--- Indexes ---\n');
      console.log(`
CREATE INDEX IF NOT EXISTS idx_zenmoney_mappings_transaction_id ON public.zenmoney_transaction_mappings(zenmoney_transaction_id);
CREATE INDEX IF NOT EXISTS idx_zenmoney_mappings_account_id ON public.zenmoney_transaction_mappings(zenmoney_account_id);
CREATE INDEX IF NOT EXISTS idx_zenmoney_mappings_ynab_transaction_id ON public.zenmoney_transaction_mappings(ynab_transaction_id);
CREATE INDEX IF NOT EXISTS idx_zenmoney_mappings_status ON public.zenmoney_transaction_mappings(status);
CREATE INDEX IF NOT EXISTS idx_zenmoney_mappings_date ON public.zenmoney_transaction_mappings(date);
      `);
      console.log('\n--- Trigger ---\n');
      console.log(`
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

COMMENT ON TABLE public.zenmoney_transaction_mappings IS 'Tracks Zenmoney to YNAB transaction synchronization for personal accounts';
      `);
      process.exit(1);
    } else if (!altError) {
      console.log('✅ Table already exists!');
    }
  } else {
    console.log('✅ Table created successfully!');
  }

  // Check if table exists
  const { data, error } = await supabase
    .from('zenmoney_transaction_mappings')
    .select('id')
    .limit(1);

  if (error) {
    if (error.code === '42P01') {
      console.error('❌ Table was not created. Please create it manually in Supabase SQL Editor.');
      process.exit(1);
    }
  } else {
    console.log('✅ Table verified successfully!');
  }
}

createZenmoneyTable()
  .then(() => {
    console.log('✅ Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
  });

