/**
 * Debug script to test Zerion date issue
 */

import { zerion } from './src/clients/zerion.js';
import { ynab } from './src/clients/ynab.js';
import { config } from './src/config/index.js';

const SOLANA_WALLET = 'DF9GjZHdtvtrtJYDg7Bn1voCfbW3FCoYQigkqx9XYFKb';
const BUDGET_ID = '9c2dd1ba-36c2-4cb9-9428-6882160a155a'; // Epic Web3
const ACCOUNT_ID = '2f993c81-d81d-4315-9cbe-ffb61dc04bf6'; // Solana wallet
const START_DATE = '2026-01-01';

async function testDateIssue() {
  console.log('🔍 Testing Zerion date issue for Solana wallet...\n');

  try {
    // Get transactions from Zerion
    console.log('📥 Fetching transactions from Zerion API...');
    const transactions = await zerion.getWalletTransactions(
      SOLANA_WALLET,
      ['solana'],
      ['USDC', 'USDT'],
      START_DATE
    );

    console.log(`✅ Fetched ${transactions.length} transactions\n`);

    if (transactions.length === 0) {
      console.log('No transactions found.');
      return;
    }

    // Show all transactions
    console.log('All transactions:');
    transactions.forEach((tx, i) => {
      const amt = parseFloat(tx.amount);
      const willBeFiltered = amt < 0.1 ? '❌ FILTERED (< 0.1)' : '✅ WILL PROCESS';
      console.log(`${i + 1}. Date: ${tx.date}, Amount: ${amt}, Type: ${tx.type}, ${willBeFiltered}`);
    });
    console.log();

    // Pick first UNfiltered transaction (>= 0.1)
    const tx = transactions.find(t => parseFloat(t.amount) >= 0.1) || transactions[0];
    console.log('First transaction:');
    console.log('  Date:', tx.date);
    console.log('  Type of date:', typeof tx.date);
    console.log('  Date length:', tx.date.length);
    console.log('  Date regex test:', /^\d{4}-\d{2}-\d{2}$/.test(tx.date));
    console.log('  Asset:', tx.asset);
    console.log('  Amount:', tx.amount);
    console.log('  Type:', tx.type);
    console.log('  Hash:', tx.hash.substring(0, 20) + '...');
    console.log();

    // Try to create in YNAB
    console.log('🔄 Attempting to create transaction in YNAB...');
    
    const ynabAmount = tx.type === 'receive' 
      ? Math.round(parseFloat(tx.amount) * 1000)
      : Math.round(-parseFloat(tx.amount) * 1000);

    console.log('  YNAB amount (milliunits):', ynabAmount);
    console.log('  Date to send to YNAB:', tx.date);
    console.log();

    try {
      const result = await ynab.createTransaction(BUDGET_ID, {
        account_id: ACCOUNT_ID,
        date: tx.date,
        amount: ynabAmount,
        payee_name: 'Test Zerion',
        memo: 'Testing date issue',
        cleared: 'cleared',
        approved: false,
        import_id: `test:${Date.now()}`
      });

      console.log('✅ SUCCESS! Transaction created:');
      console.log('  Transaction ID:', result.id);
      console.log('  Date in YNAB:', result.date);
      
    } catch (error: any) {
      console.log('❌ FAILED to create transaction:');
      console.log('  Error:', error.message);
      
      if (error.message.includes('400')) {
        console.log('\n🔍 This is the "invalid date" error!');
        console.log('  Date value sent:', tx.date);
        console.log('  Date type:', typeof tx.date);
        console.log('  Date bytes:', Buffer.from(tx.date).toString('hex'));
      }
    }

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

testDateIssue();

