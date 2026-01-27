import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function checkTable() {
  console.log('🔍 Checking if zenmoney_transaction_mappings table exists...');
  
  const { data, error } = await supabase
    .from('zenmoney_transaction_mappings')
    .select('id')
    .limit(1);

  if (error) {
    if (error.code === '42P01') {
      console.log('❌ Table does NOT exist');
      console.log('\n📋 Please run the SQL from create_zenmoney_table.sql in Supabase SQL Editor');
    } else {
      console.log('⚠️  Error checking table:', error.message);
    }
  } else {
    console.log('✅ Table EXISTS!');
  }
}

checkTable();
















