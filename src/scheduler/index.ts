import cron from 'node-cron';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { collectAllFees } from '../services/collector.js';
import { collectAllDammV2Fees } from '../services/collector-dammv2.js';
import { executeMultiBuyback, shouldExecuteBuyback } from '../services/buyback.js';
import { burnAllTokens } from '../services/burner.js';
import { updateAllMarketcaps } from '../services/marketcap.js';
import { discoverPlatformPools, updateMigrationStatus } from '../services/discovery.js';
import { processRetryQueue, cleanupRetryQueue } from '../services/retry.js';

const log = logger.child({ module: 'scheduler' });

interface ScheduledTask {
  name: string;
  cronExpression: string;
  task: cron.ScheduledTask | null;
  isRunning: boolean;
}

const tasks: Map<string, ScheduledTask> = new Map();

/**
 * Fee collection task - collects partner fees from DBC pools AND LP fees from DAMM v2 pools
 */
async function feeCollectionTask(): Promise<void> {
  const taskInfo = tasks.get('fee_collection');
  if (taskInfo?.isRunning) {
    log.warn('Fee collection already running, skipping');
    return;
  }

  if (taskInfo) {
    taskInfo.isRunning = true;
  }

  try {
    log.info('Running scheduled fee collection');

    // Collect from DBC pools (partner fees)
    const dbcResult = await collectAllFees();
    log.info(
      {
        pools: dbcResult.totalPoolsProcessed,
        collected: dbcResult.totalQuoteCollected,
      },
      'DBC fee collection completed'
    );

    // Collect from DAMM v2 pools (LP fees from migrated pools)
    const dammResult = await collectAllDammV2Fees();
    log.info(
      {
        pools: dammResult.totalPoolsProcessed,
        solCollected: dammResult.totalSolCollected,
        tokensCollected: dammResult.totalTokensCollected,
      },
      'DAMM v2 fee collection completed'
    );

  } catch (error) {
    log.error({ error }, 'Scheduled fee collection failed');
  } finally {
    if (taskInfo) {
      taskInfo.isRunning = false;
    }
  }
}

/**
 * Buyback task - swaps collected SOL for ALL platform tokens (proportional to marketcap)
 */
async function buybackTask(): Promise<void> {
  const taskInfo = tasks.get('buyback');
  if (taskInfo?.isRunning) {
    log.warn('Buyback already running, skipping');
    return;
  }

  if (taskInfo) {
    taskInfo.isRunning = true;
  }

  try {
    log.info('Running scheduled multi-token buyback');

    // Check if buyback is needed
    const { shouldBuyback, balance, threshold } = await shouldExecuteBuyback();

    if (!shouldBuyback) {
      log.info({ balance, threshold }, 'Buyback threshold not met, skipping');
      return;
    }

    // Execute proportional multi-token buyback
    const result = await executeMultiBuyback();

    if (result.success) {
      log.info(
        {
          totalSolUsed: result.totalSolUsed,
          poolsSuccessful: result.poolsSuccessful,
          poolsFailed: result.poolsFailed,
        },
        'Scheduled multi-token buyback completed'
      );

      // Execute multi-token burn if configured
      if (config.scheduler.burnAfterBuyback) {
        log.info('Executing post-buyback multi-token burn');
        const burnResult = await burnAllTokens();
        if (burnResult.success) {
          log.info(
            { totalBurned: burnResult.totalBurned, poolsSuccessful: burnResult.poolsSuccessful },
            'Post-buyback multi-token burn completed'
          );
        }
      }
    } else {
      log.warn('Scheduled multi-token buyback had no successful swaps');
    }
  } catch (error) {
    log.error({ error }, 'Scheduled buyback failed');
  } finally {
    if (taskInfo) {
      taskInfo.isRunning = false;
    }
  }
}

/**
 * Marketcap update task - refreshes marketcap data for all pools
 */
async function marketcapTask(): Promise<void> {
  const taskInfo = tasks.get('marketcap');
  if (taskInfo?.isRunning) {
    log.warn('Marketcap update already running, skipping');
    return;
  }

  if (taskInfo) {
    taskInfo.isRunning = true;
  }

  try {
    log.info('Running scheduled marketcap update');
    const result = await updateAllMarketcaps();
    log.info(
      { updated: result.poolsUpdated, failed: result.poolsFailed, totalMarketcap: result.totalMarketcap },
      'Scheduled marketcap update completed'
    );
  } catch (error) {
    log.error({ error }, 'Scheduled marketcap update failed');
  } finally {
    if (taskInfo) {
      taskInfo.isRunning = false;
    }
  }
}

/**
 * Discovery task - discovers missing pools from on-chain and checks migration status
 */
async function discoveryTask(): Promise<void> {
  const taskInfo = tasks.get('discovery');
  if (taskInfo?.isRunning) {
    log.warn('Pool discovery already running, skipping');
    return;
  }

  if (taskInfo) {
    taskInfo.isRunning = true;
  }

  try {
    log.info('Running scheduled pool discovery');
    
    // Discover new pools
    const result = await discoverPlatformPools();
    log.info(
      { discovered: result.poolsDiscovered, new: result.poolsNew, existing: result.poolsExisting },
      'Scheduled pool discovery completed'
    );

    // Check migration status for existing pools
    const migrationResult = await updateMigrationStatus();
    if (migrationResult.migratedFound > 0) {
      log.info(
        { checked: migrationResult.checked, migrated: migrationResult.migratedFound },
        'Migration status update completed'
      );
    }
  } catch (error) {
    log.error({ error }, 'Scheduled pool discovery failed');
  } finally {
    if (taskInfo) {
      taskInfo.isRunning = false;
    }
  }
}

/**
 * Retry queue task - processes failed operations
 */
async function retryTask(): Promise<void> {
  const taskInfo = tasks.get('retry');
  if (taskInfo?.isRunning) {
    log.warn('Retry processing already running, skipping');
    return;
  }

  if (taskInfo) {
    taskInfo.isRunning = true;
  }

  try {
    log.debug('Processing retry queue');
    const result = await processRetryQueue();
    if (result.processed > 0) {
      log.info(result, 'Retry queue processing completed');
    }

    // Cleanup old entries weekly
    await cleanupRetryQueue(7);
  } catch (error) {
    log.error({ error }, 'Retry queue processing failed');
  } finally {
    if (taskInfo) {
      taskInfo.isRunning = false;
    }
  }
}

/**
 * Start all scheduled tasks
 */
export function startScheduler(): void {
  log.info('Starting scheduler');

  // Fee collection task
  const feeCollectionCron = config.scheduler.feeCollectionCron;
  if (cron.validate(feeCollectionCron)) {
    const task = cron.schedule(feeCollectionCron, feeCollectionTask, {
      scheduled: true,
      timezone: 'UTC',
    });

    tasks.set('fee_collection', {
      name: 'Fee Collection',
      cronExpression: feeCollectionCron,
      task,
      isRunning: false,
    });

    log.info({ cron: feeCollectionCron }, 'Fee collection scheduled');
  } else {
    log.error({ cron: feeCollectionCron }, 'Invalid fee collection cron expression');
  }

  // Buyback task (multi-token)
  const buybackCron = config.scheduler.buybackCron;
  if (cron.validate(buybackCron)) {
    const task = cron.schedule(buybackCron, buybackTask, {
      scheduled: true,
      timezone: 'UTC',
    });

    tasks.set('buyback', {
      name: 'Multi-Token Buyback',
      cronExpression: buybackCron,
      task,
      isRunning: false,
    });

    log.info({ cron: buybackCron }, 'Multi-token buyback scheduled');
  } else {
    log.error({ cron: buybackCron }, 'Invalid buyback cron expression');
  }

  // Marketcap update task - every hour
  const marketcapCron = config.scheduler.marketcapCron || '0 * * * *';
  if (cron.validate(marketcapCron)) {
    const task = cron.schedule(marketcapCron, marketcapTask, {
      scheduled: true,
      timezone: 'UTC',
    });

    tasks.set('marketcap', {
      name: 'Marketcap Update',
      cronExpression: marketcapCron,
      task,
      isRunning: false,
    });

    log.info({ cron: marketcapCron }, 'Marketcap update scheduled');
  }

  // Pool discovery task - every 4 hours
  const discoveryCron = config.scheduler.discoveryCron || '0 */4 * * *';
  if (cron.validate(discoveryCron)) {
    const task = cron.schedule(discoveryCron, discoveryTask, {
      scheduled: true,
      timezone: 'UTC',
    });

    tasks.set('discovery', {
      name: 'Pool Discovery',
      cronExpression: discoveryCron,
      task,
      isRunning: false,
    });

    log.info({ cron: discoveryCron }, 'Pool discovery scheduled');
  }

  // Retry queue task - every 5 minutes
  const retryCron = '*/5 * * * *';
  if (cron.validate(retryCron)) {
    const task = cron.schedule(retryCron, retryTask, {
      scheduled: true,
      timezone: 'UTC',
    });

    tasks.set('retry', {
      name: 'Retry Queue',
      cronExpression: retryCron,
      task,
      isRunning: false,
    });

    log.info({ cron: retryCron }, 'Retry queue scheduled');
  }

  log.info({ taskCount: tasks.size }, 'Scheduler started');
}

/**
 * Stop all scheduled tasks
 */
export function stopScheduler(): void {
  log.info('Stopping scheduler');

  for (const [name, taskInfo] of tasks) {
    if (taskInfo.task) {
      taskInfo.task.stop();
      log.info({ name }, 'Task stopped');
    }
  }

  tasks.clear();
  log.info('Scheduler stopped');
}

/**
 * Get scheduler status
 */
export function getSchedulerStatus(): Array<{
  name: string;
  cronExpression: string;
  isRunning: boolean;
}> {
  return Array.from(tasks.values()).map((task) => ({
    name: task.name,
    cronExpression: task.cronExpression,
    isRunning: task.isRunning,
  }));
}

/**
 * Manually trigger a task
 */
export async function triggerTask(
  taskName: 'fee_collection' | 'buyback' | 'marketcap' | 'discovery' | 'retry'
): Promise<void> {
  switch (taskName) {
    case 'fee_collection':
      await feeCollectionTask();
      break;
    case 'buyback':
      await buybackTask();
      break;
    case 'marketcap':
      await marketcapTask();
      break;
    case 'discovery':
      await discoveryTask();
      break;
    case 'retry':
      await retryTask();
      break;
    default:
      throw new Error(`Unknown task: ${taskName}`);
  }
}
