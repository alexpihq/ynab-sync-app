#!/usr/bin/env node

import { jobWorker } from './services/jobWorker.js';
import { logger } from './utils/logger.js';
import { config } from './config/index.js';

/**
 * Главная функция приложения
 */
async function main() {
  logger.info('🚀 YNAB Loan Sync App starting...');
  logger.info('Configuration:', {
    mode: 'job-worker',
    syncStartDate: config.syncStartDate,
    logLevel: config.logLevel,
    finologEnabled: !!config.finologApiToken,
    aspireEnabled: !!config.aspireProxyUrl,
    tronEnabled: !!(config.tronWalletAddress && config.tronApiKey),
  });

  // Запускаем Job Worker для обработки задач из очереди
  logger.info('Starting Job Worker mode...');
  logger.info('Jobs will be processed from Supabase sync_jobs table');
  logger.info('Create jobs via dashboard or Supabase Edge Function');
  
  try {
    await jobWorker.start();
  } catch (error) {
    logger.error('Failed to start job worker:', error);
    process.exit(1);
  }

  // Обработка сигналов завершения
  const shutdown = async (signal: string) => {
    logger.info(`\n${signal} received, shutting down gracefully...`);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Запускаем приложение
main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});

