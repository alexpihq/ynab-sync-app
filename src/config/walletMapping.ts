/**
 * Wallet to YNAB Account Mapping
 * 
 * This file contains the mapping of cryptocurrency wallet addresses
 * to YNAB budget accounts for Zerion synchronization.
 */

export interface WalletMapping {
  walletAddress: string;
  budgetId: string;
  accountId: string;
  budgetName: string;
  budgetCurrency: 'USD' | 'EUR'; // Budget currency for conversion
  description?: string;
}

export const WALLET_MAPPINGS: WalletMapping[] = [
  // Epic Web3 Budget (9c2dd1ba-36c2-4cb9-9428-6882160a155a) - USD
  {
    walletAddress: '0x82F52BdE8c4b744af3a55d81a76959f7df8B0dAa',
    budgetId: '9c2dd1ba-36c2-4cb9-9428-6882160a155a',
    accountId: '293d7299-4969-4601-9f33-a6b37a2ebf12',
    budgetName: 'Epic Web3',
    budgetCurrency: 'USD',
    description: 'Wallet 0x82F5...0dAa'
  },
  {
    walletAddress: '0xFB4F73630e8a83C2645D11aaA51Ee09a10C33a56',
    budgetId: '9c2dd1ba-36c2-4cb9-9428-6882160a155a',
    accountId: 'c155d736-bf9b-4fb1-8f40-a790b3ec945a',
    budgetName: 'Epic Web3',
    budgetCurrency: 'USD',
    description: 'Wallet 0xFB4F...3a56'
  },
  {
    walletAddress: '0x68d03371748986A897D7999a8CB40E044c05BA54',
    budgetId: '9c2dd1ba-36c2-4cb9-9428-6882160a155a',
    accountId: '4898adfe-7f9b-47f7-8d8f-f6f7e5a58580',
    budgetName: 'Epic Web3',
    budgetCurrency: 'USD',
    description: 'Wallet 0x68d0...BA54'
  },
  {
    walletAddress: '0xda4a77521F05DC0671FF2944D1Fb14ee0E4977a3',
    budgetId: '9c2dd1ba-36c2-4cb9-9428-6882160a155a',
    accountId: '37c3fc45-1cd2-42cf-8a9a-ab0f9b579cb8',
    budgetName: 'Epic Web3',
    budgetCurrency: 'USD',
    description: 'Wallet 0xda4a...77a3'
  },
  {
    walletAddress: '0xE0A5Ae83365b2BeE7869324E378310D566f8f77c',
    budgetId: '9c2dd1ba-36c2-4cb9-9428-6882160a155a',
    accountId: 'a9166321-9603-44c4-a0f4-52d1441aabfd',
    budgetName: 'Epic Web3',
    budgetCurrency: 'USD',
    description: 'Wallet 0xE0A5...f77c'
  },
  {
    walletAddress: 'DF9GjZHdtvtrtJYDg7Bn1voCfbW3FCoYQigkqx9XYFKb',
    budgetId: '9c2dd1ba-36c2-4cb9-9428-6882160a155a',
    accountId: '2f993c81-d81d-4315-9cbe-ffb61dc04bf6',
    budgetName: 'Epic Web3',
    budgetCurrency: 'USD',
    description: 'Solana Wallet DF9G...YFKb'
  },

  // Alex Budget (90024622-dd15-4ef9-bfad-4e555f5471ac) - EUR (requires USD to EUR conversion)
  {
    walletAddress: '0x029cB45ef8f6Dcd8191f8Ce238730983E47b2a08',
    budgetId: '90024622-dd15-4ef9-bfad-4e555f5471ac',
    accountId: '3d852d5c-0dce-4050-b4ba-39f1241b7677',
    budgetName: 'Alex Budget',
    budgetCurrency: 'EUR',
    description: 'Wallet 0x029c...2a08'
  },

  // Innerly Budget (6dd20115-3f86-44d8-9dfa-911c699034dc) - USD
  {
    walletAddress: '0x479624417561A1B53F508c41409AdEDd8cEDbaaf',
    budgetId: '6dd20115-3f86-44d8-9dfa-911c699034dc',
    accountId: '3fea31dc-a371-42b2-95fe-46d7956e9def',
    budgetName: 'Innerly Budget',
    budgetCurrency: 'USD',
    description: 'Wallet 0x4796...baaf'
  }
];

// Allowed blockchain networks
export const ALLOWED_CHAINS = [
  'polygon',
  'binance-smart-chain',
  'ethereum',
  'arbitrum',
  'solana',
  'base'
];

// Only sync these assets
// USDT0 = legitimate USDT on Polygon network
export const LEGIT_ASSETS = ['USDC', 'USDT', 'USDT0'];

