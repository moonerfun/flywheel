import { PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
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
 * Discover all pools using the platform's config key
 */
export async function discoverPlatformPools(): Promise<DiscoveryResult> {
  const platformConfigKey = config.discovery?.configKey;

  if (!platformConfigKey) {
    log.warn('No platform config key configured for discovery');
    return {
      poolsDiscovered: 0,
      poolsNew: 0,
      poolsExisting: 0,
      errors: [{ poolAddress: '', error: 'No config key configured' }],
    };
  }

  return discoverPoolsByConfig(platformConfigKey);
}

/**
 * Sync missing pools - compares on-chain with database
 */
export async function syncMissingPools(): Promise<{
  synced: number;
  errors: number;
}> {
  const supabase = getSupabaseUntyped();
  const platformConfigKey = config.discovery?.configKey;

  if (!platformConfigKey) {
    return { synced: 0, errors: 0 };
  }

  log.info('Syncing missing pools');

  try {
    // Discover all pools on-chain
    const discovery = await discoverPoolsByConfig(platformConfigKey);

    return {
      synced: discovery.poolsNew,
      errors: discovery.errors.length,
    };
  } catch (error) {
    log.error({ error }, 'Failed to sync missing pools');
    return { synced: 0, errors: 1 };
  }
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
