/**
 * Test Alex Budget wallet with EUR conversion
 */

import { zerion } from './src/clients/zerion.js';
import { ynab } from './src/clients/ynab.js';
import { convertUsdToEur } from './src/services/currency.js';

const ALEX_WALLET = '0x029cB45ef8f6Dcd8191f8Ce238730983E47b2a08';
const BUDGET_ID = '90024622-dd15-4ef9-bfad-4e555f5471ac'; // Alex Budget
const ACCOUNT_ID = '3d852d5c-0dce-4050-b4ba-39f1241b7677';
const START_DATE = '2026-01-01';

async function testAlexWallet() {
  console.log('🔍 Testing Alex Budget wallet with EUR conversion...\n');

  try {
    // Get transactions from Zerion
    console.log('📥 Fetching transactions from Zerion API...');
    const transactions = await zerion.getWalletTransactions(
      ALEX_WALLET,
      ['polygon', 'binance-smart-chain', 'ethereum', 'arbitrum', 'solana', 'base'],
      ['USDC', 'USDT', 'USDT0'],
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
      console.log(`${i + 1}. Date: ${tx.date}, Amount: ${amt} ${tx.asset}, Type: ${tx.type}, Chain: ${tx.chain}, ${willBeFiltered}`);
    });
    console.log();

    // Pick first valid transaction (>= 0.1)
    const tx = transactions.find(t => parseFloat(t.amount) >= 0.1);
    
    if (!tx) {
      console.log('No transactions >= 0.1 USD found.');
      return;
    }

    console.log('Testing with first valid transaction:');
    console.log('  Date:', tx.date);
    console.log('  Type of date:', typeof tx.date);
    console.log('  Date regex test:', /^\d{4}-\d{2}-\d{2}$/.test(tx.date));
    console.log('  Asset:', tx.asset);
    console.log('  Amount (USD):', tx.amount);
    console.log('  Type:', tx.type);
    console.log('  Hash:', tx.hash.substring(0, 20) + '...');
    console.log();

    // Test EUR conversion
    console.log('💱 Testing USD → EUR conversion...');
    const amountInUsdMilliunits = Math.round(parseFloat(tx.amount) * 1000);
    console.log('  USD milliunits:', amountInUsdMilliunits);
    
    const convertedAmount = await convertUsdToEur(amountInUsdMilliunits, tx.date);
    
    if (convertedAmount === null) {
      console.log('  ❌ Conversion failed (missing exchange rate)');
      return;
    }
    
    console.log('  EUR milliunits:', convertedAmount);
    console.log('  EUR amount:', (convertedAmount / 1000).toFixed(2));
    console.log();

    const ynabAmount = tx.type === 'receive' ? convertedAmount : -convertedAmount;

    // Try to create in YNAB
    console.log('🔄 Attempting to create transaction in YNAB (Alex Budget - EUR)...');
    console.log('  YNAB amount (EUR milliunits):', ynabAmount);
    console.log('  Date to send to YNAB:', tx.date);
    console.log('  Date type:', typeof tx.date);
    console.log();

    try {
      const result = await ynab.createTransaction(BUDGET_ID, {
        account_id: ACCOUNT_ID,
        date: tx.date,
        amount: ynabAmount,
        payee_name: 'Test Alex EUR',
        memo: 'Testing EUR conversion',
        cleared: 'cleared',
        approved: false,
        import_id: `test-alex:${Date.now()}`
      });

      console.log('✅ SUCCESS! Transaction created:');
      console.log('  Transaction ID:', result.id);
      console.log('  Date in YNAB:', result.date);
      console.log('  Amount:', result.amount);
      
    } catch (error: any) {
      console.log('❌ FAILED to create transaction:');
      console.log('  Error:', error.message);
      
      if (error.message.includes('400')) {
        console.log('\n🔍 This is a 400 error!');
        console.log('  Date value sent:', tx.date);
        console.log('  Date type:', typeof tx.date);
        console.log('  Date length:', tx.date.length);
        console.log('  Date bytes (hex):', Buffer.from(tx.date).toString('hex'));
      }
    }

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

testAlexWallet();


















