import dotenv from 'dotenv';
import { AppConfig } from '../types/index.js';

// Загружаем переменные окружения
dotenv.config();

function getEnvVar(key: string, required = true): string {
  const value = process.env[key];
  if (required && !value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || '';
}

export const config: AppConfig = {
  // YNAB
  ynabToken: getEnvVar('YNAB_TOKEN'),
  
  // Finolog (optional)
  finologApiToken: getEnvVar('FINOLOG_API_TOKEN', false),
  
  // Aspire Bank (optional) - теперь используем прямые запросы вместо прокси
  // aspireProxyUrl: getEnvVar('ASPIRE_PROXY_URL', false) || 'https://aspire-proxy-render.onrender.com', // Закомментировано
  aspireClientId: getEnvVar('ASPIRE_CLIENT_ID', false),
  aspireClientSecret: getEnvVar('ASPIRE_CLIENT_SECRET', false),
  
  // Tron Blockchain (optional)
  tronWalletAddress: getEnvVar('TRON_WALLET_ADDRESS', false) || '',
  tronApiKey: getEnvVar('TRON_API_KEY', false) || '',
  
  // Zerion API (optional)
  zerionApiKey: getEnvVar('ZERION_API_KEY', false) || '',
  
  // TBank Business API (optional)
  tbankToken: getEnvVar('TBANK_TOKEN', false) || '',
  
  // Zenmoney API (optional)
  zenmoneyToken: getEnvVar('ZENMONEY_TOKEN', false) || '',
  
  // Supabase
  supabaseUrl: getEnvVar('SUPABASE_URL'),
  supabaseServiceKey: getEnvVar('SUPABASE_SERVICE_ROLE_KEY'),
  
  // Budget IDs
  personalBudgetId: getEnvVar('PERSONAL_BUDGET_ID'),
  innerlyBudgetId: getEnvVar('INNERLY_BUDGET_ID'),
  vibeconBudgetId: getEnvVar('VIBECON_BUDGET_ID'),
  epicWeb3BudgetId: getEnvVar('EPIC_WEB3_BUDGET_ID', false) || '9c2dd1ba-36c2-4cb9-9428-6882160a155a',
  
  // Sync configuration
  syncIntervalMinutes: parseInt(getEnvVar('SYNC_INTERVAL_MINUTES', false) || '5'),
  logLevel: (getEnvVar('LOG_LEVEL', false) || 'info') as 'debug' | 'info' | 'warn' | 'error',
  syncStartDate: getEnvVar('SYNC_START_DATE', false) || '2026-01-01',
};

// Константы для работы с бюджетами
export const BUDGETS = {
  PERSONAL: {
    id: config.personalBudgetId,
    name: 'Alex Personal',
    type: 'personal' as const,
    currency: 'EUR' as const,
  },
  INNERLY: {
    id: config.innerlyBudgetId,
    name: 'Innerly',
    type: 'company' as const,
    currency: 'USD' as const,
  },
  VIBECON: {
    id: config.vibeconBudgetId,
    name: 'Vibecon',
    type: 'company' as const,
    currency: 'USD' as const,
  },
  EPIC_WEB3: {
    id: config.epicWeb3BudgetId,
    name: 'Epic Web3',
    type: 'company' as const,
    currency: 'USD' as const,
  },
} as const;

// Список всех компаний для итерации
export const COMPANIES = [BUDGETS.INNERLY, BUDGETS.VIBECON, BUDGETS.EPIC_WEB3] as const;

// API endpoints
export const YNAB_API_BASE = 'https://api.ynab.com/v1';

