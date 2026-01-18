import { getSupabaseUntyped, type RetryQueueItem, type RetryQueueInsert } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { registerPool, type RegisterPoolParams } from './registry.js';
import { claimFeesFromPool, type FeeClaimResult } from './collector.js';
import { executeBuybackForPool, type BuybackResult } from './buyback.js';
import { burnTokensForPool, type BurnResult } from './burner.js';
import { getPoolByAddress } from './registry.js';

const log = logger.child({ module: 'retry-queue' });

// Retry backoff multiplier (exponential backoff)
const RETRY_BACKOFF_BASE_SECONDS = 60; // 1 minute base
const MAX_RETRY_BACKOFF_SECONDS = 3600; // 1 hour max

/**
 * Add an operation to the retry queue
 */
export async function addToRetryQueue(
  operationType: 'fee_claim' | 'buyback' | 'burn' | 'register',
  poolAddress: string | null,
  payload: Record<string, unknown>,
  maxRetries: number = 5
): Promise<void> {
  try {
    const supabase = getSupabaseUntyped();

    const item: RetryQueueInsert = {
      operation_type: operationType,
      pool_address: poolAddress,
      payload,
      max_retries: maxRetries,
      next_retry_at: new Date().toISOString(),
    };

    await supabase.from('retry_queue').insert(item);

    log.info({ operationType, poolAddress }, 'Added to retry queue');
  } catch (error) {
    // If database is offline, log to file system as fallback
    log.error({ error, operationType, poolAddress, payload }, 'Failed to add to retry queue - DATABASE OFFLINE');
    
    // Store in local file as emergency fallback
    await storeLocalFallback(operationType, poolAddress, payload);
  }
}

/**
 * Store operation in local file when database is completely offline
 */
async function storeLocalFallback(
  operationType: string,
  poolAddress: string | null,
  payload: Record<string, unknown>
): Promise<void> {
  const fs = await import('fs/promises');
  const path = await import('path');

  try {
    const fallbackDir = path.join(process.cwd(), 'data', 'retry-fallback');
    await fs.mkdir(fallbackDir, { recursive: true });

    const filename = `${Date.now()}-${operationType}.json`;
    const filepath = path.join(fallbackDir, filename);

    await fs.writeFile(
      filepath,
      JSON.stringify({
        operationType,
        poolAddress,
        payload,
        createdAt: new Date().toISOString(),
      }),
      'utf-8'
    );

    log.warn({ filepath }, 'Stored operation in local fallback file');
  } catch (fileError) {
    log.error({ fileError }, 'Failed to store local fallback');
  }
}

/**
 * Process local fallback files when database comes back online
 */
export async function processLocalFallbacks(): Promise<number> {
  const fs = await import('fs/promises');
  const path = await import('path');

  let processed = 0;
  const fallbackDir = path.join(process.cwd(), 'data', 'retry-fallback');

  try {
    const files = await fs.readdir(fallbackDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const filepath = path.join(fallbackDir, file);
      const content = await fs.readFile(filepath, 'utf-8');
      const data = JSON.parse(content) as {
        operationType: 'fee_claim' | 'buyback' | 'burn' | 'register';
        poolAddress: string | null;
        payload: Record<string, unknown>;
      };

      await addToRetryQueue(data.operationType, data.poolAddress, data.payload);

      // Delete the file after successful queue
      await fs.unlink(filepath);
      processed++;
    }

    if (processed > 0) {
      log.info({ processed }, 'Processed local fallback files');
    }
  } catch (error) {
    // Directory might not exist, which is fine
    if ((error as { code?: string }).code !== 'ENOENT') {
      log.error({ error }, 'Failed to process local fallbacks');
    }
  }

  return processed;
}

/**
 * Get pending items from the retry queue
 */
export async function getPendingRetries(): Promise<RetryQueueItem[]> {
  const supabase = getSupabaseUntyped();

  const { data, error } = await supabase
    .from('retry_queue')
    .select('*')
    .eq('status', 'pending')
    .lte('next_retry_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(10);

  if (error) {
    log.error({ error }, 'Failed to get pending retries');
    return [];
  }

  return (data || []) as RetryQueueItem[];
}

/**
 * Calculate next retry time with exponential backoff
 */
function calculateNextRetryTime(retryCount: number): Date {
  const backoffSeconds = Math.min(
    RETRY_BACKOFF_BASE_SECONDS * Math.pow(2, retryCount),
    MAX_RETRY_BACKOFF_SECONDS
  );
  return new Date(Date.now() + backoffSeconds * 1000);
}

/**
 * Process a single retry queue item
 */
async function processRetryItem(item: RetryQueueItem): Promise<boolean> {
  const supabase = getSupabaseUntyped();

  // Mark as processing
  await supabase
    .from('retry_queue')
    .update({
      status: 'processing',
      last_attempt_at: new Date().toISOString(),
    })
    .eq('id', item.id);

  try {
    let success = false;

    switch (item.operation_type) {
      case 'register': {
        const params = item.payload as unknown as RegisterPoolParams;
        await registerPool(params);
        success = true;
        break;
      }

      case 'fee_claim': {
        if (item.pool_address) {
          const pool = await getPoolByAddress(item.pool_address);
          if (pool) {
            const result = await claimFeesFromPool(pool);
            success = result.success;
          }
        }
        break;
      }

      case 'buyback': {
        if (item.pool_address) {
          const pool = await getPoolByAddress(item.pool_address);
          if (pool) {
            const solAmount = (item.payload.solAmount as number) || 0;
            const result = await executeBuybackForPool(pool, solAmount);
            success = result.success;
          }
        }
        break;
      }

      case 'burn': {
        if (item.pool_address) {
          const pool = await getPoolByAddress(item.pool_address);
          if (pool) {
            const result = await burnTokensForPool(pool);
            success = result.success;
          }
        }
        break;
      }
    }

    if (success) {
      // Mark as completed
      await supabase
        .from('retry_queue')
        .update({
          status: 'completed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id);

      log.info({ id: item.id, operationType: item.operation_type }, 'Retry succeeded');
      return true;
    } else {
      throw new Error('Operation returned unsuccessful');
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const newRetryCount = item.retry_count + 1;

    if (newRetryCount >= item.max_retries) {
      // Max retries reached - mark as failed
      await supabase
        .from('retry_queue')
        .update({
          status: 'failed',
          retry_count: newRetryCount,
          last_error: errorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id);

      log.error({ id: item.id, retryCount: newRetryCount, error: errorMessage }, 'Retry failed permanently');
    } else {
      // Schedule next retry with backoff
      const nextRetryAt = calculateNextRetryTime(newRetryCount);

      await supabase
        .from('retry_queue')
        .update({
          status: 'pending',
          retry_count: newRetryCount,
          last_error: errorMessage,
          next_retry_at: nextRetryAt.toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', item.id);

      log.warn(
        { id: item.id, retryCount: newRetryCount, nextRetryAt, error: errorMessage },
        'Retry failed, scheduled for later'
      );
    }

    return false;
  }
}

/**
 * Process all pending retry queue items
 */
export async function processRetryQueue(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  log.info('Processing retry queue');

  const result = {
    processed: 0,
    succeeded: 0,
    failed: 0,
  };

  // First, try to process any local fallback files
  await processLocalFallbacks();

  // Get pending items
  const pendingItems = await getPendingRetries();

  for (const item of pendingItems) {
    result.processed++;
    const success = await processRetryItem(item);

    if (success) {
      result.succeeded++;
    } else {
      result.failed++;
    }

    // Small delay between retries
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (result.processed > 0) {
    log.info(result, 'Retry queue processing completed');
  }

  return result;
}

/**
 * Get retry queue stats
 */
export async function getRetryQueueStats(): Promise<{
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}> {
  const supabase = getSupabaseUntyped();

  const { data } = await supabase
    .from('retry_queue')
    .select('status');

  const stats = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  };

  if (data) {
    for (const item of data as Array<{ status: string }>) {
      switch (item.status) {
        case 'pending':
          stats.pending++;
          break;
        case 'processing':
          stats.processing++;
          break;
        case 'completed':
          stats.completed++;
          break;
        case 'failed':
          stats.failed++;
          break;
      }
    }
  }

  return stats;
}

/**
 * Clean up old completed/failed items from retry queue
 */
export async function cleanupRetryQueue(olderThanDays: number = 7): Promise<number> {
  const supabase = getSupabaseUntyped();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  const { data, error } = await supabase
    .from('retry_queue')
    .delete()
    .in('status', ['completed', 'failed'])
    .lt('updated_at', cutoffDate.toISOString())
    .select('id');

  if (error) {
    log.error({ error }, 'Failed to cleanup retry queue');
    return 0;
  }

  const count = (data || []).length;
  if (count > 0) {
    log.info({ count, olderThanDays }, 'Cleaned up retry queue');
  }

  return count;
}
