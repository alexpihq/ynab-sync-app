#!/usr/bin/env node

/**
 * Скрипт для проверки подключения к YNAB и Supabase
 */

import { ynab } from './clients/ynab.js';
import { supabase } from './clients/supabase.js';
import { logger } from './utils/logger.js';
import { config, BUDGETS } from './config/index.js';

async function testConnections() {
  logger.info('🔍 Testing connections...\n');

  let allSuccess = true;

  // Тест YNAB
  try {
    logger.info('Testing YNAB API connection...');
    const { transactions } = await ynab.getTransactions(
      BUDGETS.PERSONAL.id,
      config.syncStartDate
    );
    logger.info(`✅ YNAB: Connected successfully! Found ${transactions.length} transactions since ${config.syncStartDate}`);
  } catch (error) {
    logger.error('❌ YNAB: Connection failed', error);
    allSuccess = false;
  }

  console.log('');

  // Тест Supabase - Budgets
  try {
    logger.info('Testing Supabase connection...');
    const budgetConfig = await supabase.getBudgetConfig(BUDGETS.PERSONAL.id);
    if (budgetConfig) {
      logger.info(`✅ Supabase: Connected successfully! Found budget: ${budgetConfig.budget_name}`);
    } else {
      logger.warn('⚠️  Supabase: Connected but budget config not found');
      allSuccess = false;
    }
  } catch (error) {
    logger.error('❌ Supabase: Connection failed', error);
    allSuccess = false;
  }

  console.log('');

  // Тест Loan Accounts
  try {
    logger.info('Checking loan accounts configuration...');
    const loanAccounts = await supabase.getLoanAccounts();
    logger.info(`✅ Found ${loanAccounts.length} loan account mappings:`);
    for (const acc of loanAccounts) {
      logger.info(`   - ${acc.company_name}: ${acc.personal_account_id} ↔ ${acc.company_account_id}`);
    }
  } catch (error) {
    logger.error('❌ Failed to fetch loan accounts', error);
    allSuccess = false;
  }

  console.log('');

  // Тест Exchange Rates
  try {
    logger.info('Checking exchange rates...');
    const month = config.syncStartDate.substring(0, 7);
    const rate = await supabase.getExchangeRate(month);
    if (rate) {
      logger.info(`✅ Exchange rate for ${month}: 1 EUR = ${rate} USD`);
    } else {
      logger.warn(`⚠️  No exchange rate found for ${month}`);
      logger.info('   Add rates using: psql $DATABASE_URL -f update_exchange_rates.sql');
    }
  } catch (error) {
    logger.error('❌ Failed to fetch exchange rate', error);
    allSuccess = false;
  }

  console.log('');

  // Итог
  if (allSuccess) {
    logger.info('🎉 All connections successful! Ready to run sync.');
    logger.info('\nTo start syncing, run:');
    logger.info('  npm run dev   (development with auto-reload)');
    logger.info('  npm start     (production)');
  } else {
    logger.error('❌ Some connections failed. Please check your configuration.');
    process.exit(1);
  }
}

testConnections().catch((error) => {
  logger.error('Fatal error during connection test:', error);
  process.exit(1);
});






