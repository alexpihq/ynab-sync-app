import { tbank } from './clients/tbank.js';
import { logger } from './utils/logger.js';

/**
 * Тестовый скрипт для проверки работы TBank API
 */
async function testTbankConnection() {
  try {
    logger.info('🧪 Testing TBank API connection...\n');

    // 1. Проверяем конфигурацию
    if (!tbank.isConfigured()) {
      logger.error('❌ TBank not configured. Please set TBANK_TOKEN in .env file');
      process.exit(1);
    }
    logger.info('✅ TBank client configured\n');

    // 2. Получаем список счетов
    logger.info('📋 Fetching TBank accounts...');
    const accounts = await tbank.getAccounts();
    
    logger.info(`\n✅ Found ${accounts.length} accounts:\n`);
    for (const account of accounts) {
      const currency = tbank.getCurrencyCode(account.currency);
      logger.info(`   💳 ${account.name}`);
      logger.info(`      Account: ${account.accountNumber}`);
      logger.info(`      Currency: ${currency}`);
      logger.info(`      Balance: ${account.balance.balance.toLocaleString()} ${currency}`);
      logger.info(`      Status: ${account.status}`);
      logger.info(`      Type: ${account.accountType}`);
      logger.info(`      Main: ${account.mainFlag === 'Y' ? 'Yes' : 'No'}\n`);
    }

    // 3. Получаем операции по основному счету
    const mainAccount = accounts.find(acc => acc.mainFlag === 'Y');
    if (!mainAccount) {
      logger.warn('⚠️  No main account found');
      return;
    }

    logger.info(`\n💰 Fetching recent operations for ${mainAccount.name}...`);
    
    // Последние 7 дней
    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date().toISOString();
    
    const operations = await tbank.getAllOperations(
      mainAccount.accountNumber,
      from,
      to,
      'Transaction'
    );

    logger.info(`\n✅ Found ${operations.length} operations in last 7 days:\n`);
    
    // Показываем первые 5 операций
    const displayOps = operations.slice(0, 5);
    for (const op of displayOps) {
      const currency = tbank.getCurrencyCode(op.accountCurrencyDigitalCode);
      const sign = op.typeOfOperation === 'Debit' ? '-' : '+';
      const payee = tbank.getPayeeName(op);
      const date = tbank.normalizeDate(op.operationDate);
      
      logger.info(`   ${sign}${op.accountAmount} ${currency}`);
      logger.info(`   Date: ${date}`);
      logger.info(`   Payee: ${payee || 'N/A'}`);
      logger.info(`   Description: ${op.description}`);
      logger.info(`   Category: ${op.category}`);
      logger.info(`   Status: ${op.operationStatus}`);
      logger.info(`   ID: ${op.operationId}\n`);
    }

    if (operations.length > 5) {
      logger.info(`   ... and ${operations.length - 5} more operations\n`);
    }

    // 4. Показываем примеры конвертации для YNAB
    if (operations.length > 0) {
      const sampleOp = operations[0];
      logger.info(`\n📊 YNAB Conversion Example:`);
      logger.info(`   TBank Amount: ${sampleOp.accountAmount}`);
      logger.info(`   YNAB Milliunits: ${tbank.convertToMilliunits(sampleOp.accountAmount)}`);
      logger.info(`   Import ID: ${tbank.generateImportId(sampleOp)}`);
      logger.info(`   Memo: ${tbank.formatMemo(sampleOp).substring(0, 100)}...`);
    }

    logger.info('\n\n✅ TBank API test completed successfully!\n');

  } catch (error: any) {
    logger.error('❌ Test failed:', error.message);
    if (error.stack) {
      logger.error(error.stack);
    }
    process.exit(1);
  }
}

// Запускаем тест
testTbankConnection();

