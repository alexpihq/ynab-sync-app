import { supabase } from './clients/supabase.js';
import { logger } from './utils/logger.js';

/**
 * Проверка существования таблицы tbank_transaction_mappings в Supabase
 */
async function checkTbankTable() {
  try {
    logger.info('🔍 Checking if tbank_transaction_mappings table exists...\n');

    // Пробуем сделать запрос к таблице
    const { data, error } = await supabase.client
      .from('tbank_transaction_mappings')
      .select('*')
      .limit(1);

    if (error) {
      if (error.message.includes('does not exist') || error.code === '42P01') {
        logger.warn('❌ Table tbank_transaction_mappings does NOT exist in Supabase\n');
        logger.info('📝 You need to create it by running the SQL script:\n');
        logger.info('   1. Open Supabase SQL Editor');
        logger.info('   2. Copy contents of create_tbank_table.sql');
        logger.info('   3. Execute the script\n');
        return false;
      } else {
        logger.error('❌ Error checking table:', error.message);
        return false;
      }
    }

    logger.info('✅ Table tbank_transaction_mappings EXISTS!\n');
    logger.info(`   Found ${data?.length || 0} records in the table`);
    
    // Показываем структуру таблицы
    if (data && data.length > 0) {
      logger.info('\n📊 Sample record structure:');
      const sampleRecord = data[0];
      for (const [key, value] of Object.entries(sampleRecord)) {
        logger.info(`   ${key}: ${typeof value}`);
      }
    } else {
      logger.info('\n   Table is empty (no records yet)');
    }

    logger.info('\n✅ Table is ready to use!');
    return true;

  } catch (error: any) {
    logger.error('❌ Error:', error.message);
    return false;
  }
}

// Запускаем проверку
checkTbankTable();


