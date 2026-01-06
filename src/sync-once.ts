#!/usr/bin/env node

import { syncService } from './services/sync.js';
import { syncFinologToYnab } from './services/finologSync.js';
import { syncAspireToYnab } from './services/aspireSync.js';
import { syncTronToYnab } from './services/tronSync.js';
import { logger } from './utils/logger.js';

/**
 * Одноразовая синхронизация (без цикла)
 */
async function syncOnce() {
  logger.info('🚀 Running one-time sync...\n');

  try {
    // 1. YNAB ↔ YNAB синхронизация (двусторонняя)
    await syncService.runSyncCycle();
    
    // 2. Finolog → YNAB синхронизация (односторонняя)
    logger.info('\n📊 Starting Finolog synchronization...\n');
    await syncFinologToYnab();
    
    // 3. Aspire Bank → YNAB Innerly синхронизация (односторонняя)
    logger.info('\n🏦 Starting Aspire Bank synchronization...\n');
    await syncAspireToYnab();
    
    // 4. Tron Blockchain → YNAB Innerly синхронизация (односторонняя)
    logger.info('\n⛓️  Starting Tron Blockchain synchronization...\n');
    await syncTronToYnab();
    
    logger.info('\n✅ All syncs completed successfully!');
    process.exit(0);
  } catch (error) {
    logger.error('❌ Sync failed:', error);
    process.exit(1);
  }
}

syncOnce();

