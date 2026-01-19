import { PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import { getSupabaseUntyped, type FlywheelPool } from '../db/index.js';
import { getConnection } from '../solana/index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { registerPool, getPoolByAddress } from './registry.js';

const log = logger.child({ module: 'discovery' });

export interface DiscoveryResult {
  poolsDiscovered: number;
  poolsNew: number;
  poolsExisting: number;
  errors: Array<{ poolAddress: string; error: string }>;
}

/**
 * Discover pools created with a specific config key on-chain
 * This is used as a fallback when the webhook/database fails
 */
export async function discoverPoolsByConfig(configKey: string): Promise<DiscoveryResult> {
  const connection = getConnection();
  const supabase = getSupabaseUntyped();

  log.info({ configKey }, 'Starting on-chain pool discovery');

  const result: DiscoveryResult = {
    poolsDiscovered: 0,
    poolsNew: 0,
    poolsExisting: 0,
    errors: [],
  };

  try {
    // Mark discovery as in progress
    await supabase
      .from('discovery_sync')
      .upsert({
        config_key: configKey,
        sync_status: 'in_progress',
        last_sync_at: new Date().toISOString(),
      })
      .eq('config_key', configKey);

    const client = new DynamicBondingCurveClient(connection, 'confirmed');
    const configPubkey = new PublicKey(configKey);

    // Get all pools for this config
    // The SDK method may vary - using getPoolsByConfig if available
    // Fallback to scanning program accounts
    let poolAddresses: string[] = [];

    try {
      // Try to get pools by config using SDK
      const pools = await client.state.getPoolsByConfig(configPubkey);
      poolAddresses = pools.map((p) => p.publicKey.toString());
      log.info({ count: poolAddresses.length }, 'Found pools via SDK');
    } catch (sdkError) {
      log.warn({ error: sdkError }, 'SDK getPoolsByConfig failed, using fallback');

      // Fallback: Scan program accounts with memcmp filter on config
      // This is slower but works as a backup
      poolAddresses = await discoverPoolsByProgramAccounts(configKey);
    }

    result.poolsDiscovered = poolAddresses.length;

    // Process each discovered pool
    for (const poolAddress of poolAddresses) {
      try {
        // Check if already registered
        const existing = await getPoolByAddress(poolAddress);

        if (existing) {
          result.poolsExisting++;
          continue;
        }

        // Get pool data from chain
        const poolPubkey = new PublicKey(poolAddress);
        const poolState = await client.state.getPool(poolPubkey);

        if (!poolState) {
          log.warn({ poolAddress }, 'Pool not found on-chain during discovery');
          continue;
        }

        // Extract pool data - SDK may return different structures
        const state = poolState as Record<string, unknown>;
        const creatorKey = state.creator as { toString(): string } | undefined;
        const configKeyFromState = state.config as { toString(): string } | undefined;

        // We need baseMint - try to get from pool state or fetch token metadata
        let baseMint = '';
        try {
          // Try to get baseMint from state object if available
          const baseMintKey = state.baseMint as { toString(): string } | undefined;
          if (baseMintKey) {
            baseMint = baseMintKey.toString();
          } else {
            // Try getPoolByBaseMint with a scan (slower fallback)
            // For now, we need the baseMint passed in or skip
            log.warn({ poolAddress }, 'Could not determine baseMint for pool');
          }
        } catch {
          // If we can't get baseMint, we might need to derive it from pool tokens
          log.warn({ poolAddress }, 'Could not determine baseMint for pool');
        }

        if (!baseMint) {
          result.errors.push({
            poolAddress,
            error: 'Could not determine baseMint',
          });
          continue;
        }

        // Register the pool
        await registerPool({
          poolAddress,
          baseMint,
          quoteMint: 'So11111111111111111111111111111111111111112', // SOL
          configKey: configKeyFromState?.toString() || configKey,
          creator: creatorKey?.toString() || '',
          name: undefined, // Will need to fetch from metadata if needed
          symbol: undefined,
        });

        result.poolsNew++;
        log.info({ poolAddress, baseMint }, 'Discovered and registered new pool');

        // Rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result.errors.push({
          poolAddress,
          error: errorMessage,
        });
        log.error({ error, poolAddress }, 'Failed to process discovered pool');
      }
    }

    // Update discovery sync record
    await supabase
      .from('discovery_sync')
      .upsert({
        config_key: configKey,
        sync_status: 'completed',
        last_sync_at: new Date().toISOString(),
        pools_discovered: result.poolsDiscovered,
        pools_new: result.poolsNew,
      })
      .eq('config_key', configKey);

    // Update global stats
    await supabase
      .from('flywheel_stats')
      .update({
        last_discovery_sync_at: new Date().toISOString(),
      })
      .eq('id', 1);

    log.info(
      {
        discovered: result.poolsDiscovered,
        new: result.poolsNew,
        existing: result.poolsExisting,
        errors: result.errors.length,
      },
      'Pool discovery completed'
    );
  } catch (error) {
    log.error({ error, configKey }, 'Pool discovery failed');

    // Record failure
    await supabase
      .from('discovery_sync')
      .upsert({
        config_key: configKey,
        sync_status: 'failed',
        error_message: error instanceof Error ? error.message : String(error),
      })
      .eq('config_key', configKey);
  }

  return result;
}

/**
 * Fallback: Discover pools by scanning program accounts
 * This is slower but works when SDK methods aren't available
 */
async function discoverPoolsByProgramAccounts(configKey: string): Promise<string[]> {
  const connection = getConnection();
  const poolAddresses: string[] = [];

  try {
    // DBC program ID (you may need to get this from the SDK or config)
    const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');

    // Scan for pool accounts that have this config key
    // This uses memcmp to filter by the config field in the account data
    const accounts = await connection.getProgramAccounts(DBC_PROGRAM_ID, {
      filters: [
        {
          memcmp: {
            offset: 8, // Discriminator offset, adjust based on actual account layout
            bytes: new PublicKey(configKey).toBase58(),
          },
        },
      ],
    });

    for (const account of accounts) {
      poolAddresses.push(account.pubkey.toString());
    }

    log.info({ count: poolAddresses.length }, 'Found pools via program account scan');
  } catch (error) {
    log.error({ error }, 'Program account scan failed');
  }

  return poolAddresses;
}

/**
 * Discover all pools using the platform's config keys (supports multiple)
 */
export async function discoverPlatformPools(): Promise<DiscoveryResult> {
  const platformConfigKeys = config.discovery?.configKeys || [];

  if (platformConfigKeys.length === 0) {
    log.warn('No platform config keys configured for discovery');
    return {
      poolsDiscovered: 0,
      poolsNew: 0,
      poolsExisting: 0,
      errors: [{ poolAddress: '', error: 'No config key configured' }],
    };
  }

  // Aggregate results from all config keys
  const aggregatedResult: DiscoveryResult = {
    poolsDiscovered: 0,
    poolsNew: 0,
    poolsExisting: 0,
    errors: [],
  };

  for (const configKey of platformConfigKeys) {
    log.info({ configKey }, 'Discovering pools for config key');
    const result = await discoverPoolsByConfig(configKey);
    
    aggregatedResult.poolsDiscovered += result.poolsDiscovered;
    aggregatedResult.poolsNew += result.poolsNew;
    aggregatedResult.poolsExisting += result.poolsExisting;
    aggregatedResult.errors.push(...result.errors);
  }

  log.info(
    { configKeysCount: platformConfigKeys.length, ...aggregatedResult },
    'Completed discovery across all config keys'
  );

  return aggregatedResult;
}

/**
 * Sync missing pools - compares on-chain with database
 */
export async function syncMissingPools(): Promise<{
  synced: number;
  errors: number;
}> {
  const platformConfigKeys = config.discovery?.configKeys || [];

  if (platformConfigKeys.length === 0) {
    return { synced: 0, errors: 0 };
  }

  log.info({ configKeysCount: platformConfigKeys.length }, 'Syncing missing pools across all config keys');

  let totalSynced = 0;
  let totalErrors = 0;

  for (const configKey of platformConfigKeys) {
    try {
      // Discover all pools on-chain for this config key
      const discovery = await discoverPoolsByConfig(configKey);
      totalSynced += discovery.poolsNew;
      totalErrors += discovery.errors.length;
    } catch (error) {
      log.error({ error, configKey }, 'Failed to sync missing pools for config key');
      totalErrors++;
    }
  }

  return {
    synced: totalSynced,
    errors: totalErrors,
  };
}

/**
 * Get last discovery sync info
 */
export async function getLastDiscoverySync(
  configKey: string
): Promise<{
  lastSyncAt: Date | null;
  poolsDiscovered: number;
  status: string;
} | null> {
  const supabase = getSupabaseUntyped();

  const { data } = await supabase
    .from('discovery_sync')
    .select('*')
    .eq('config_key', configKey)
    .single();

  if (!data) return null;

  const syncData = data as {
    last_sync_at: string;
    pools_discovered: number;
    sync_status: string;
  };

  return {
    lastSyncAt: syncData.last_sync_at ? new Date(syncData.last_sync_at) : null,
    poolsDiscovered: syncData.pools_discovered,
    status: syncData.sync_status,
  };
}

/**
 * Check if a DBC pool is migrated and get its DAMM v2 address
 */
export async function checkPoolMigration(poolAddress: string): Promise<{
  isMigrated: boolean;
  migrationProgress: number;
  dammPoolAddress: string | null;
}> {
  const connection = getConnection();

  try {
    const client = new DynamicBondingCurveClient(connection, 'confirmed');
    const poolPubkey = new PublicKey(poolAddress);

    const poolState = await client.state.getPool(poolPubkey);

    if (!poolState) {
      return { isMigrated: false, migrationProgress: 0, dammPoolAddress: null };
    }

    // Check if pool is migrated - check the numeric isMigrated field
    const state = poolState as Record<string, unknown>;
    const isMigratedValue = state.isMigrated as number | boolean | undefined;
    const isMigrated = isMigratedValue === 1 || isMigratedValue === true;
    const migrationProgress = (state.migrationProgress as number) || 0;

    if (!isMigrated) {
      return { isMigrated: false, migrationProgress, dammPoolAddress: null };
    }

    // DBC SDK doesn't expose the DAMM pool address directly
    // We need to find it by scanning CP-AMM pools with this token
    return { isMigrated, migrationProgress, dammPoolAddress: null };
  } catch (error) {
    log.error({ error, poolAddress }, 'Failed to check pool migration status');
    return { isMigrated: false, migrationProgress: 0, dammPoolAddress: null };
  }
}

/**
 * Find DAMM v2 pool address by token mint
 * Searches the CP-AMM program for pools containing the given token
 */
export async function findDammV2PoolByMint(tokenMint: string): Promise<string | null> {
  const connection = getConnection();

  try {
    const cpAmm = new CpAmm(connection);
    const mintPubkey = new PublicKey(tokenMint);

    // Use fetchPoolStatesByTokenAMint to find pools where token is Token A
    // (Migrated pools from DBC have the token as tokenA and SOL as tokenB)
    const pools = await cpAmm.fetchPoolStatesByTokenAMint(mintPubkey);

    if (pools && pools.length > 0) {
      // Return the first pool found (should typically be the migrated pool)
      const dammPoolAddress = pools[0].publicKey.toString();
      log.info({ tokenMint, dammPoolAddress }, 'Found DAMM v2 pool by token mint');
      return dammPoolAddress;
    }

    // No pool found with this token as Token A
    log.debug({ tokenMint }, 'No DAMM v2 pool found for token mint');
    return null;
  } catch (error) {
    log.error({ error, tokenMint }, 'Failed to find DAMM v2 pool by mint');
    return null;
  }
}

/**
 * Update migration status for all pools
 */
export async function updateMigrationStatus(): Promise<{
  checked: number;
  migratedFound: number;
  dammPoolsFound: number;
  errors: number;
}> {
  const supabase = getSupabaseUntyped();
  const connection = getConnection();

  log.info('Checking pool migration status');

  const result = {
    checked: 0,
    migratedFound: 0,
    dammPoolsFound: 0,
    errors: 0,
  };

  try {
    // Get all DBC pools that either:
    // 1. Aren't marked as migrated yet, OR
    // 2. Are migrated but don't have a DAMM pool address
    const { data: pools } = await supabase
      .from('flywheel_pools')
      .select('*')
      .or('is_migrated.eq.false,and(is_migrated.eq.true,damm_pool_address.is.null)')
      .in('status', ['active', 'migrated']);

    if (!pools || pools.length === 0) {
      log.info('No pools to check for migration');
      return result;
    }

    const client = new DynamicBondingCurveClient(connection, 'confirmed');

    for (const pool of pools) {
      result.checked++;

      try {
        const poolPubkey = new PublicKey(pool.pool_address);
        const poolState = await client.state.getPool(poolPubkey);

        if (!poolState) {
          continue;
        }

        // Check migration status
        const state = poolState as Record<string, unknown>;
        const isMigratedValue = state.isMigrated as number | boolean | undefined;
        const isMigrated = isMigratedValue === 1 || isMigratedValue === true;

        if (isMigrated) {
          if (!pool.is_migrated) {
            result.migratedFound++;
          }

          let dammPoolAddress = pool.damm_pool_address;

          // If we don't have the DAMM pool address, try to find it
          if (!dammPoolAddress) {
            dammPoolAddress = await findDammV2PoolByMint(pool.base_mint);
            if (dammPoolAddress) {
              result.dammPoolsFound++;
            }
          }

          // Update database
          await supabase
            .from('flywheel_pools')
            .update({
              is_migrated: true,
              damm_pool_address: dammPoolAddress,
              status: 'migrated',
            })
            .eq('id', pool.id);

          log.info(
            { poolAddress: pool.pool_address, dammPoolAddress, baseMint: pool.base_mint },
            'Pool marked as migrated'
          );
        }

        // Rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        log.error({ error, poolAddress: pool.pool_address }, 'Failed to check pool migration');
        result.errors++;
      }
    }

    log.info(result, 'Migration status check completed');
  } catch (error) {
    log.error({ error }, 'Failed to update migration status');
  }

  return result;
}
