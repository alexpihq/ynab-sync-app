import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { EventEmitter } from 'events';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { syncService } from '../services/sync.js';
import { syncFinologToYnab } from '../services/finologSync.js';
import { syncAspireToYnab } from '../services/aspireSync.js';
import { syncTronToYnab } from '../services/tronSync.js';
import { syncTbankToYnab } from '../services/tbankSync.js';
import { syncZenmoneyToYnab } from '../services/zenmoneySync.js';
import { zerionSyncService } from '../services/zerionSync.js';
import { syncConversionAccounts } from '../services/conversionSync.js';
import { supabase } from '../clients/supabase.js';
import { ynab } from '../clients/ynab.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Event emitter для реалтайм логов
const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50);

// Helper для эмита логов в SSE
function emitLog(level: 'info' | 'warn' | 'error', message: string) {
  if (syncState.isRunning) {
    logEmitter.emit('log', { level, message, timestamp: new Date().toISOString() });
  }
}

// Wrapper для logger чтобы эмитить логи
const originalLogInfo = logger.info.bind(logger);
const originalLogWarn = logger.warn.bind(logger);
const originalLogError = logger.error.bind(logger);

// Helper to serialize any value for SSE
function serializeForLog(arg: any): string {
  if (arg instanceof Error) {
    return `${arg.message}${arg.stack ? '\n' + arg.stack : ''}`;
  }
  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.stringify(arg);
    } catch (e) {
      return String(arg);
    }
  }
  return String(arg);
}

logger.info = (...args: any[]) => {
  const message = args.map(serializeForLog).join(' ');
  originalLogInfo(...args);
  emitLog('info', message);
};

logger.warn = (...args: any[]) => {
  const message = args.map(serializeForLog).join(' ');
  originalLogWarn(...args);
  emitLog('warn', message);
};

logger.error = (...args: any[]) => {
  const message = args.map(serializeForLog).join(' ');
  originalLogError(...args);
  emitLog('error', message);
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware - проверяет JWT токен от Supabase
const requireAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  
  const token = authHeader.substring(7);
  
  try {
    const { data: { user }, error } = await supabase.client.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
    
    // Добавляем пользователя в request для использования в handlers
    (req as any).user = user;
    next();
  } catch (error) {
    logger.error('Auth error:', error);
    res.status(401).json({ error: 'Unauthorized: Token verification failed' });
  }
};

// Sync state
interface SyncState {
  isRunning: boolean;
  lastRun: Date | null;
  lastResult: {
    success: boolean;
    message: string;
    ynab?: any;
    finolog?: any;
    aspire?: any;
    tron?: any;
    zerion?: any;
  } | null;
  history: Array<{
    timestamp: Date;
    success: boolean;
    message: string;
    duration: number;
  }>;
}

const syncState: SyncState = {
  isRunning: false,
  lastRun: null,
  lastResult: null,
  history: []
};

// API Routes

// Supabase config endpoint - для клиента
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || config.supabaseServiceRoleKey // Используем anon key если есть
  });
});

// Get server's outbound IP address
app.get('/api/server-ip', async (req, res) => {
  try {
    // Try multiple IP services for reliability
    const ipServices = [
      'https://api.ipify.org?format=json',
      'https://api64.ipify.org?format=json',
      'https://ifconfig.me/ip',
      'https://icanhazip.com'
    ];

    for (const serviceUrl of ipServices) {
      try {
        const response = await fetch(serviceUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'YNAB-Sync-App/1.0'
          },
          signal: AbortSignal.timeout(5000) // 5 second timeout
        });

        if (response.ok) {
          const text = await response.text();
          
          // Try to parse as JSON first
          try {
            const json = JSON.parse(text);
            return res.json({ 
              ip: json.ip || text.trim(),
              source: serviceUrl,
              timestamp: new Date().toISOString()
            });
          } catch {
            // If not JSON, return as plain text
            return res.json({ 
              ip: text.trim(),
              source: serviceUrl,
              timestamp: new Date().toISOString()
            });
          }
        }
      } catch (error) {
        logger.debug(`Failed to get IP from ${serviceUrl}:`, error);
        continue; // Try next service
      }
    }

    // If all services failed, return error
    res.status(503).json({ 
      error: 'Unable to determine server IP address',
      message: 'All IP lookup services failed'
    });
  } catch (error) {
    logger.error('Error getting server IP:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: String(error)
    });
  }
});

app.get('/api/sync/status', requireAuth, (req, res) => {
  res.json(syncState);
});

// SSE endpoint для реалтайм логов
app.get('/api/sync/logs/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendLog = (data: { level: string; message: string }) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  logEmitter.on('log', sendLog);

  // Отправляем keepalive каждые 30 секунд
  const keepAliveInterval = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30000);

  req.on('close', () => {
    logEmitter.off('log', sendLog);
    clearInterval(keepAliveInterval);
  });
});

app.post('/api/sync/run', requireAuth, async (req, res) => {
  if (syncState.isRunning) {
    return res.status(409).json({ error: 'Sync already running' });
  }

  // Start sync in background
  runFullSync();
  
  res.json({ success: true, message: 'Sync started' });
});

app.post('/api/sync/run/:type', requireAuth, async (req, res) => {
  const { type } = req.params;
  
  if (syncState.isRunning) {
    return res.status(409).json({ error: 'Sync already running' });
  }

  if (!['ynab', 'finolog', 'aspire', 'tron', 'tbank', 'zenmoney', 'zerion', 'conversion'].includes(type)) {
    return res.status(400).json({ error: 'Invalid sync type' });
  }

  // Start specific sync in background
  runSpecificSync(type);
  
  res.json({ success: true, message: `${type} sync started` });
});

// Public endpoint for external cron services (e.g., cron-job.org, EasyCron)
// Protected by secret token instead of user authentication
// Supports both GET (for testing) and POST (for cron services)
const handleCronSync = async (req: express.Request, res: express.Response) => {
  const cronSecret = process.env.CRON_SECRET;
  
  if (!cronSecret) {
    logger.warn('⚠️  CRON_SECRET not set, cron endpoint disabled');
    return res.status(503).json({ error: 'Cron endpoint not configured' });
  }

  const providedSecret = req.headers['x-cron-secret'] || req.query.secret;
  
  if (providedSecret !== cronSecret) {
    logger.warn('⚠️  Invalid cron secret provided');
    return res.status(401).json({ error: 'Unauthorized: Invalid secret' });
  }

  if (syncState.isRunning) {
    logger.info('⏰ Cron triggered but sync already running, skipping...');
    return res.status(409).json({ 
      error: 'Sync already running',
      message: 'Another sync is currently in progress'
    });
  }

  logger.info('⏰ Cron-triggered sync started');
  
  // Start sync in background
  runFullSync();
  
  res.json({ 
    success: true, 
    message: 'Sync started via cron',
    timestamp: new Date().toISOString()
  });
};

// Support both GET (for testing) and POST (for cron services)
app.get('/api/cron/sync', handleCronSync);
app.post('/api/cron/sync', handleCronSync);

// Health check endpoint (also wakes up the app on free Render)
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    syncRunning: syncState.isRunning,
    lastSync: syncState.lastRun?.toISOString() || null
  });
});

// Exchange rates endpoints
app.get('/api/rates', requireAuth, async (req, res) => {
  try {
    logger.info('GET /api/rates - fetching exchange rates');
    const { data, error } = await supabase.client
      .from('exchange_rates')
      .select('*')
      .order('month', { ascending: false });

    if (error) {
      logger.error('Supabase error:', error);
      throw error;
    }

    logger.info(`Successfully fetched ${data?.length || 0} rates`);
    res.json({ success: true, data });
  } catch (error: any) {
    logger.error('Error fetching rates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/rates', requireAuth, async (req, res) => {
  try {
    const { month, eur_to_usd, gbp_to_usd, eur_to_rub, usd_to_sgd, source } = req.body;

    const { data, error } = await supabase.client
      .from('exchange_rates')
      .insert({
        month,
        eur_to_usd,
        gbp_to_usd,
        eur_to_rub,
        usd_to_sgd,
        source
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (error: any) {
    logger.error('Error creating rate:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/rates/:month', requireAuth, async (req, res) => {
  try {
    const { month } = req.params;
    const { eur_to_usd, gbp_to_usd, eur_to_rub, usd_to_sgd, source } = req.body;

    const { data, error } = await supabase.client
      .from('exchange_rates')
      .update({
        eur_to_usd,
        gbp_to_usd,
        eur_to_rub,
        usd_to_sgd,
        source,
        updated_at: new Date().toISOString()
      })
      .eq('month', month)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, data });
  } catch (error: any) {
    logger.error('Error updating rate:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/rates/:month', requireAuth, async (req, res) => {
  try {
    const { month } = req.params;

    const { error } = await supabase.client
      .from('exchange_rates')
      .delete()
      .eq('month', month);

    if (error) throw error;

    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error deleting rate:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// YNAB data endpoints
app.get('/api/ynab/budgets', requireAuth, async (req, res) => {
  try {
    const budgets = await ynab.getBudgets();
    res.json({ success: true, data: budgets });
  } catch (error: any) {
    logger.error('Error fetching YNAB budgets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/ynab/budgets/:budgetId/accounts', requireAuth, async (req, res) => {
  try {
    const { budgetId } = req.params;
    const accounts = await ynab.getAccounts(budgetId);
    // Filter out closed accounts
    const openAccounts = accounts.filter(a => !a.closed);
    res.json({ success: true, data: openAccounts });
  } catch (error: any) {
    logger.error('Error fetching YNAB accounts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Conversion accounts endpoints
app.get('/api/conversion-accounts', requireAuth, async (req, res) => {
  try {
    const accounts = await supabase.getAllConversionAccounts();
    res.json({ success: true, data: accounts });
  } catch (error: any) {
    logger.error('Error fetching conversion accounts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/conversion-accounts', requireAuth, async (req, res) => {
  try {
    const { budget_id, account_id, source_currency, target_currency } = req.body;

    if (!budget_id || !account_id || !source_currency || !target_currency) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: budget_id, account_id, source_currency, target_currency'
      });
    }

    const account = await supabase.createConversionAccount(
      budget_id,
      account_id,
      source_currency,
      target_currency
    );

    if (!account) {
      return res.status(500).json({ success: false, error: 'Failed to create account' });
    }

    res.json({ success: true, data: account });
  } catch (error: any) {
    logger.error('Error creating conversion account:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/conversion-accounts/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { budget_id, account_id, source_currency, target_currency, is_active } = req.body;

    const account = await supabase.updateConversionAccount(id, {
      budget_id,
      account_id,
      source_currency,
      target_currency,
      is_active,
    });

    if (!account) {
      return res.status(500).json({ success: false, error: 'Failed to update account' });
    }

    res.json({ success: true, data: account });
  } catch (error: any) {
    logger.error('Error updating conversion account:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/conversion-accounts/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const success = await supabase.deleteConversionAccount(id);

    if (!success) {
      return res.status(500).json({ success: false, error: 'Failed to delete account' });
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error deleting conversion account:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== Linked Transactions endpoints =====
// These are bank transfers that match mirror transactions (preventing duplicate creation)
app.get('/api/linked-transactions', requireAuth, async (req, res) => {
  try {
    const transactions = await supabase.getAllLinkedTransactions();
    res.json({ success: true, data: transactions });
  } catch (error: any) {
    logger.error('Error fetching linked transactions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/linked-transactions/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const transaction = await supabase.getLinkedTransactionById(id);

    if (!transaction) {
      return res.status(404).json({ success: false, error: 'Linked transaction not found' });
    }

    res.json({ success: true, data: transaction });
  } catch (error: any) {
    logger.error('Error fetching linked transaction:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/linked-transactions', requireAuth, async (req, res) => {
  try {
    const {
      budget_id_1,
      transaction_id_1,
      account_id_1,
      budget_id_2,
      transaction_id_2,
      account_id_2,
      amount,
      transaction_date,
      link_type,
      link_reason,
      is_auto_matched
    } = req.body;

    if (!budget_id_1 || !transaction_id_1 ||
        !budget_id_2 || !transaction_id_2 ||
        amount === undefined || !transaction_date) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    const transaction = await supabase.createLinkedTransaction({
      budget_id_1,
      transaction_id_1,
      account_id_1: account_id_1 || null,
      budget_id_2,
      transaction_id_2,
      account_id_2: account_id_2 || null,
      amount,
      transaction_date,
      link_type: link_type || 'manual',
      link_reason: link_reason || null,
      is_auto_matched: is_auto_matched || false
    });

    if (!transaction) {
      return res.status(500).json({ success: false, error: 'Failed to create linked transaction' });
    }

    res.json({ success: true, data: transaction });
  } catch (error: any) {
    logger.error('Error creating linked transaction:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/linked-transactions/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const transaction = await supabase.updateLinkedTransaction(id, updates);

    if (!transaction) {
      return res.status(500).json({ success: false, error: 'Failed to update linked transaction' });
    }

    res.json({ success: true, data: transaction });
  } catch (error: any) {
    logger.error('Error updating linked transaction:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/linked-transactions/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const success = await supabase.deleteLinkedTransaction(id);

    if (!success) {
      return res.status(500).json({ success: false, error: 'Failed to delete linked transaction' });
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error deleting linked transaction:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== Loan Accounts endpoints (Personal ↔ Company) =====
app.get('/api/loan-accounts', requireAuth, async (req, res) => {
  try {
    const accounts = await supabase.getAllLoanAccounts();
    res.json({ success: true, data: accounts });
  } catch (error: any) {
    logger.error('Error fetching loan accounts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/loan-accounts', requireAuth, async (req, res) => {
  try {
    const {
      company_budget_id,
      company_name,
      personal_account_id,
      personal_account_name,
      company_account_id,
      company_account_name,
      is_active
    } = req.body;

    if (!company_budget_id || !personal_account_id || !company_account_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: company_budget_id, personal_account_id, company_account_id'
      });
    }

    const account = await supabase.createLoanAccount({
      company_budget_id,
      company_name: company_name || '',
      personal_account_id,
      personal_account_name: personal_account_name || '',
      company_account_id,
      company_account_name: company_account_name || '',
      is_active: is_active !== false
    });

    if (!account) {
      return res.status(500).json({ success: false, error: 'Failed to create loan account' });
    }

    res.json({ success: true, data: account });
  } catch (error: any) {
    logger.error('Error creating loan account:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/loan-accounts/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const account = await supabase.updateLoanAccount(id, updates);

    if (!account) {
      return res.status(500).json({ success: false, error: 'Failed to update loan account' });
    }

    res.json({ success: true, data: account });
  } catch (error: any) {
    logger.error('Error updating loan account:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/loan-accounts/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const success = await supabase.deleteLoanAccount(id);

    if (!success) {
      return res.status(500).json({ success: false, error: 'Failed to delete loan account' });
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error deleting loan account:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== Company Loan Accounts endpoints (Company ↔ Company) =====
app.get('/api/company-loan-accounts', requireAuth, async (req, res) => {
  try {
    const accounts = await supabase.getAllCompanyLoanAccounts();
    res.json({ success: true, data: accounts });
  } catch (error: any) {
    logger.error('Error fetching company loan accounts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/company-loan-accounts', requireAuth, async (req, res) => {
  try {
    const {
      budget_id_1,
      budget_name_1,
      account_id_1,
      account_name_1,
      budget_id_2,
      budget_name_2,
      account_id_2,
      account_name_2,
      currency,
      is_active
    } = req.body;

    if (!budget_id_1 || !account_id_1 || !budget_id_2 || !account_id_2) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: budget_id_1, account_id_1, budget_id_2, account_id_2'
      });
    }

    const account = await supabase.createCompanyLoanAccount({
      budget_id_1,
      budget_name_1: budget_name_1 || '',
      account_id_1,
      account_name_1: account_name_1 || '',
      budget_id_2,
      budget_name_2: budget_name_2 || '',
      account_id_2,
      account_name_2: account_name_2 || '',
      currency: currency || 'USD',
      is_active: is_active !== false
    });

    if (!account) {
      return res.status(500).json({ success: false, error: 'Failed to create company loan account' });
    }

    res.json({ success: true, data: account });
  } catch (error: any) {
    logger.error('Error creating company loan account:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/company-loan-accounts/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const account = await supabase.updateCompanyLoanAccount(id, updates);

    if (!account) {
      return res.status(500).json({ success: false, error: 'Failed to update company loan account' });
    }

    res.json({ success: true, data: account });
  } catch (error: any) {
    logger.error('Error updating company loan account:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/company-loan-accounts/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const success = await supabase.deleteCompanyLoanAccount(id);

    if (!success) {
      return res.status(500).json({ success: false, error: 'Failed to delete company loan account' });
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error deleting company loan account:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get transactions from loan accounts for a given month
app.get('/api/loan-account-transactions', requireAuth, async (req, res) => {
  try {
    const { loan_account_id, month } = req.query;

    if (!loan_account_id || !month) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: loan_account_id, month (YYYY-MM)'
      });
    }

    // Get the company loan account
    const loanAccounts = await supabase.getAllCompanyLoanAccounts();
    const loanAccount = loanAccounts.find(a => a.id === loan_account_id);

    if (!loanAccount) {
      return res.status(404).json({ success: false, error: 'Loan account not found' });
    }

    // Calculate date range for the month
    const [year, monthNum] = (month as string).split('-').map(Number);
    const startDate = `${year}-${String(monthNum).padStart(2, '0')}-01`;
    const endDate = monthNum === 12
      ? `${year + 1}-01-01`
      : `${year}-${String(monthNum + 1).padStart(2, '0')}-01`;

    // Fetch transactions from both accounts
    const [transactions1, transactions2] = await Promise.all([
      ynab.getTransactionsByDateRange(loanAccount.budget_id_1, loanAccount.account_id_1, startDate, endDate),
      ynab.getTransactionsByDateRange(loanAccount.budget_id_2, loanAccount.account_id_2, startDate, endDate)
    ]);

    res.json({
      success: true,
      data: {
        account_1: {
          budget_id: loanAccount.budget_id_1,
          budget_name: loanAccount.budget_name_1,
          account_id: loanAccount.account_id_1,
          account_name: loanAccount.account_name_1,
          transactions: transactions1
        },
        account_2: {
          budget_id: loanAccount.budget_id_2,
          budget_name: loanAccount.budget_name_2,
          account_id: loanAccount.account_id_2,
          account_name: loanAccount.account_name_2,
          transactions: transactions2
        }
      }
    });
  } catch (error: any) {
    logger.error('Error fetching loan account transactions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== Wallet Mappings endpoints (Zerion sync) =====
app.get('/api/wallet-mappings', requireAuth, async (req, res) => {
  try {
    const mappings = await supabase.getAllWalletMappings();
    res.json({ success: true, data: mappings });
  } catch (error: any) {
    logger.error('Error fetching wallet mappings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/wallet-mappings', requireAuth, async (req, res) => {
  try {
    const {
      wallet_address,
      wallet_name,
      budget_id,
      budget_name,
      account_id,
      account_name,
      budget_currency,
      is_active
    } = req.body;

    if (!wallet_address || !budget_id || !account_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: wallet_address, budget_id, account_id'
      });
    }

    const mapping = await supabase.createWalletMapping({
      wallet_address,
      wallet_name: wallet_name || null,
      budget_id,
      budget_name: budget_name || '',
      account_id,
      account_name: account_name || null,
      budget_currency: budget_currency || 'USD',
      is_active: is_active !== false
    });

    if (!mapping) {
      return res.status(500).json({ success: false, error: 'Failed to create wallet mapping' });
    }

    res.json({ success: true, data: mapping });
  } catch (error: any) {
    logger.error('Error creating wallet mapping:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/wallet-mappings/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const mapping = await supabase.updateWalletMapping(id, updates);

    if (!mapping) {
      return res.status(500).json({ success: false, error: 'Failed to update wallet mapping' });
    }

    res.json({ success: true, data: mapping });
  } catch (error: any) {
    logger.error('Error updating wallet mapping:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/wallet-mappings/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const success = await supabase.deleteWalletMapping(id);

    if (!success) {
      return res.status(500).json({ success: false, error: 'Failed to delete wallet mapping' });
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error('Error deleting wallet mapping:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Sync functions
async function runFullSync() {
  if (syncState.isRunning) {
    logger.warn('Sync already running, skipping...');
    return;
  }

  syncState.isRunning = true;
  const startTime = Date.now();
  
  try {
    logger.info('🔄 Starting full sync...');
    
    const results: any = {};

    // YNAB ↔ YNAB
    try {
      logger.info('📊 YNAB synchronization...');
      const ynabResult = await syncService.runSyncCycle();
      results.ynab = ynabResult;
    } catch (error) {
      logger.error('YNAB sync failed:', error);
      results.ynab = { error: String(error) };
    }

    // Finolog → YNAB
    try {
      logger.info('💼 Finolog synchronization...');
      const finologResult = await syncFinologToYnab();
      results.finolog = finologResult;
    } catch (error) {
      logger.error('Finolog sync failed:', error);
      results.finolog = { error: String(error) };
    }

    // Aspire → YNAB
    try {
      logger.info('🏦 Aspire synchronization...');
      const aspireResult = await syncAspireToYnab();
      results.aspire = aspireResult;
    } catch (error) {
      logger.error('Aspire sync failed:', error);
      results.aspire = { error: String(error) };
    }

    // Tron → YNAB
    try {
      logger.info('⛓️  Tron synchronization...');
      const tronResult = await syncTronToYnab();
      results.tron = tronResult;
    } catch (error) {
      logger.error('Tron sync failed:', error);
      results.tron = { error: String(error) };
    }

    // TBank → YNAB
    try {
      logger.info('🏦 TBank synchronization...');
      const tbankResult = await syncTbankToYnab();
      results.tbank = tbankResult;
    } catch (error) {
      logger.error('TBank sync failed:', error);
      results.tbank = { error: String(error) };
    }

    // Zenmoney → YNAB
    try {
      logger.info('💳 Zenmoney synchronization...');
      const zenmoneyResult = await syncZenmoneyToYnab();
      results.zenmoney = zenmoneyResult;
    } catch (error) {
      logger.error('Zenmoney sync failed:', error);
      results.zenmoney = { error: String(error) };
    }

    // Zerion → YNAB
    try {
      logger.info('🔗 Zerion wallets synchronization...');
      const zerionResult = await zerionSyncService.syncAllWallets();
      results.zerion = zerionResult;
    } catch (error) {
      logger.error('Zerion sync failed:', error);
      results.zerion = { error: String(error) };
    }

    // Currency Conversion
    try {
      logger.info('💱 Currency conversion synchronization...');
      const conversionResult = await syncConversionAccounts();
      results.conversion = conversionResult;
    } catch (error) {
      logger.error('Currency conversion sync failed:', error);
      results.conversion = { error: String(error) };
    }

    const duration = Date.now() - startTime;
    
    syncState.lastRun = new Date();
    syncState.lastResult = {
      success: true,
      message: 'Full sync completed',
      ...results
    };
    
    syncState.history.unshift({
      timestamp: new Date(),
      success: true,
      message: 'Full sync completed',
      duration
    });
    
    // Keep only last 50 history items
    if (syncState.history.length > 50) {
      syncState.history = syncState.history.slice(0, 50);
    }
    
    logger.info(`✅ Full sync completed in ${duration}ms`);
    
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Full sync failed:', error);
    
    syncState.lastRun = new Date();
    syncState.lastResult = {
      success: false,
      message: String(error)
    };
    
    syncState.history.unshift({
      timestamp: new Date(),
      success: false,
      message: String(error),
      duration
    });
    
    if (syncState.history.length > 50) {
      syncState.history = syncState.history.slice(0, 50);
    }
    
  } finally {
    syncState.isRunning = false;
  }
}

async function runSpecificSync(type: string) {
  if (syncState.isRunning) {
    logger.warn('Sync already running, skipping...');
    return;
  }

  syncState.isRunning = true;
  const startTime = Date.now();
  
  try {
    logger.info(`🔄 Starting ${type} sync...`);
    
    let result: any;
    
    switch (type) {
      case 'ynab':
        result = await syncService.runSyncCycle();
        break;
      case 'finolog':
        result = await syncFinologToYnab();
        break;
      case 'aspire':
        result = await syncAspireToYnab();
        break;
      case 'tron':
        result = await syncTronToYnab();
        break;
      case 'tbank':
        result = await syncTbankToYnab();
        break;
      case 'zenmoney':
        result = await syncZenmoneyToYnab();
        break;
      case 'zerion':
        result = await zerionSyncService.syncAllWallets();
        break;
      case 'conversion':
        result = await syncConversionAccounts();
        break;
    }
    
    const duration = Date.now() - startTime;
    
    // Log result for debugging
    logger.info(`${type} sync result:`, JSON.stringify(result));
    logger.info(`Result is undefined: ${result === undefined}, Result is null: ${result === null}`);
    
    const lastResult: any = {
      success: true,
      message: `${type} sync completed`,
    };
    lastResult[type] = result || { error: 'No data returned' };
    
    syncState.lastRun = new Date();
    syncState.lastResult = lastResult;
    
    logger.info(`syncState.lastResult after save:`, JSON.stringify(syncState.lastResult));
    
    syncState.history.unshift({
      timestamp: new Date(),
      success: true,
      message: `${type} sync completed`,
      duration
    });
    
    if (syncState.history.length > 50) {
      syncState.history = syncState.history.slice(0, 50);
    }
    
    logger.info(`✅ ${type} sync completed in ${duration}ms`);
    
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(`${type} sync failed:`, error);
    
    syncState.lastRun = new Date();
    syncState.lastResult = {
      success: false,
      message: String(error)
    };
    
    syncState.history.unshift({
      timestamp: new Date(),
      success: false,
      message: `${type} sync failed: ${String(error)}`,
      duration
    });
    
    if (syncState.history.length > 50) {
      syncState.history = syncState.history.slice(0, 50);
    }
    
  } finally {
    syncState.isRunning = false;
  }
}

// Helper to calculate next midnight UTC
function getNextMidnightUTC(): Date {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow;
}

// Helper to calculate next hour UTC
function getNextHourUTC(): Date {
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0);
  return nextHour;
}

// Hourly sync for YNAB ↔ YNAB and Currency Conversion
async function runHourlySync() {
  if (syncState.isRunning) {
    logger.warn('Sync already running, skipping hourly sync...');
    return;
  }

  syncState.isRunning = true;
  const startTime = Date.now();

  try {
    logger.info('⏰ Starting hourly sync (YNAB + Conversion)...');

    const results: any = {};

    // YNAB ↔ YNAB
    try {
      logger.info('📊 YNAB synchronization...');
      const ynabResult = await syncService.runSyncCycle();
      results.ynab = ynabResult;
    } catch (error) {
      logger.error('YNAB sync failed:', error);
      results.ynab = { error: String(error) };
    }

    // Currency Conversion
    try {
      logger.info('💱 Currency conversion synchronization...');
      const conversionResult = await syncConversionAccounts();
      results.conversion = conversionResult;
    } catch (error) {
      logger.error('Currency conversion sync failed:', error);
      results.conversion = { error: String(error) };
    }

    const duration = Date.now() - startTime;

    syncState.lastRun = new Date();
    syncState.lastResult = {
      success: true,
      message: 'Hourly sync completed (YNAB + Conversion)',
      ...results
    };

    syncState.history.unshift({
      timestamp: new Date(),
      success: true,
      message: 'Hourly sync completed (YNAB + Conversion)',
      duration
    });

    if (syncState.history.length > 50) {
      syncState.history = syncState.history.slice(0, 50);
    }

    logger.info(`✅ Hourly sync completed in ${duration}ms`);

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Hourly sync failed:', error);

    syncState.lastRun = new Date();
    syncState.lastResult = {
      success: false,
      message: String(error)
    };

    syncState.history.unshift({
      timestamp: new Date(),
      success: false,
      message: `Hourly sync failed: ${String(error)}`,
      duration
    });

    if (syncState.history.length > 50) {
      syncState.history = syncState.history.slice(0, 50);
    }

  } finally {
    syncState.isRunning = false;
  }
}

// Schedule automatic sync once per day at midnight UTC
// Runs daily since the app is on paid Render plan (no sleep)
cron.schedule('0 0 * * *', () => {
  logger.info('⏰ Scheduled daily sync triggered at midnight UTC');
  runFullSync();
});

// Schedule hourly sync for YNAB ↔ YNAB and Currency Conversion
// Runs every hour at minute 0 (except midnight when full sync runs)
cron.schedule('0 1-23 * * *', () => {
  logger.info('⏰ Scheduled hourly sync triggered (YNAB + Conversion)');
  runHourlySync();
});

// Start server
app.listen(PORT, () => {
  logger.info(`🚀 Server running on http://localhost:${PORT}`);
  logger.info(`⏰ Automatic sync schedules:`);
  logger.info(`   📅 Full sync: daily at 00:00 UTC → ${getNextMidnightUTC().toISOString()}`);
  logger.info(`   🔄 Hourly sync (YNAB + Conversion): every hour at :00 → ${getNextHourUTC().toISOString()}`);
  logger.info(`   Alternative: External cron → POST /api/cron/sync?secret=YOUR_SECRET`);
  logger.info(`🔐 Authentication: Supabase Auth`);
  logger.info(`📋 Health check: GET /api/health`);
  
  // Automatic initial sync disabled - run manually from dashboard
  // setTimeout(() => {
  //   logger.info('🔄 Running initial sync...');
  //   runFullSync();
  // }, 10000);
});

