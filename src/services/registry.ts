import { PublicKey } from '@solana/web3.js';
import { getSupabaseUntyped, type FlywheelPool, type FlywheelPoolInsert } from '../db/index.js';
import { getConnection } from '../solana/index.js';
import { logger } from '../utils/logger.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

const log = logger.child({ module: 'registry' });

export interface RegisterPoolParams {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  configKey: string;
  creator: string;
  name?: string;
  symbol?: string;
}

/**
 * Register a new pool for flywheel tracking
 */
export async function registerPool(params: RegisterPoolParams): Promise<FlywheelPool> {
  const supabase = getSupabaseUntyped();

  log.info({ poolAddress: params.poolAddress }, 'Registering pool for flywheel');

  // Check if pool already exists
  const { data: existing } = await supabase
    .from('flywheel_pools')
    .select('*')
    .eq('pool_address', params.poolAddress)
    .single();

  if (existing) {
    log.info({ poolAddress: params.poolAddress }, 'Pool already registered');
    return existing as FlywheelPool;
  }

  // Insert new pool
  const poolData: FlywheelPoolInsert = {
    pool_address: params.poolAddress,
    base_mint: params.baseMint,
    quote_mint: params.quoteMint,
    config_key: params.configKey,
    creator: params.creator,
    name: params.name || null,
    symbol: params.symbol || null,
    status: 'active',
  };

  const { data, error } = await supabase
    .from('flywheel_pools')
    .insert(poolData)
    .select()
    .single();

  if (error) {
    log.error({ error }, 'Failed to register pool');
    throw new Error(`Failed to register pool: ${error.message}`);
  }

  // Log operation
  await supabase.from('operation_logs').insert({
    operation_type: 'register',
    status: 'completed',
    details: { pool_address: params.poolAddress, name: params.name, symbol: params.symbol },
  });

  log.info({ poolAddress: params.poolAddress, id: (data as FlywheelPool).id }, 'Pool registered successfully');
  return data as FlywheelPool;
}

/**
 * Get all active pools
 */
export async function getActivePools(): Promise<FlywheelPool[]> {
  const supabase = getSupabaseUntyped();

  const { data, error } = await supabase
    .from('flywheel_pools')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (error) {
    log.error({ error }, 'Failed to fetch active pools');
    throw new Error(`Failed to fetch active pools: ${error.message}`);
  }

  return (data || []) as FlywheelPool[];
}

/**
 * Get pool by address
 */
export async function getPoolByAddress(poolAddress: string): Promise<FlywheelPool | null> {
  const supabase = getSupabaseUntyped();

  const { data, error } = await supabase
    .from('flywheel_pools')
    .select('*')
    .eq('pool_address', poolAddress)
    .single();

  if (error && error.code !== 'PGRST116') {
    log.error({ error }, 'Failed to fetch pool');
    throw new Error(`Failed to fetch pool: ${error.message}`);
  }

  return (data as FlywheelPool) || null;
}

/**
 * Update pool status
 */
export async function updatePoolStatus(
  poolAddress: string,
  status: 'active' | 'inactive' | 'migrated'
): Promise<void> {
  const supabase = getSupabaseUntyped();

  const { error } = await supabase
    .from('flywheel_pools')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('pool_address', poolAddress);

  if (error) {
    log.error({ error }, 'Failed to update pool status');
    throw new Error(`Failed to update pool status: ${error.message}`);
  }

  log.info({ poolAddress, status }, 'Pool status updated');
}

/**
 * Sync pool data from on-chain
 * Note: This function requires baseMint to be known. For new pools, 
 * use registerPool directly with all required parameters.
 */
export async function syncPoolFromChain(poolAddress: string, baseMint?: string): Promise<FlywheelPool | null> {
  const connection = getConnection();

  try {
    const client = new DynamicBondingCurveClient(connection, 'confirmed');
    const poolPubkey = new PublicKey(poolAddress);

    // Fetch pool state from chain using state namespace
    const poolState = await client.state.getPool(poolPubkey);

    if (!poolState) {
      log.warn({ poolAddress }, 'Pool not found on-chain');
      return null;
    }

    // The pool state structure may vary - access properties safely
    // Type assertion needed as SDK types may not be fully accurate
    const state = poolState as Record<string, unknown>;
    
    // Try to extract values, using fallbacks
    const configKey = (state.config as { toString(): string } | undefined)?.toString() || '';
    const creator = (state.creator as { toString(): string } | undefined)?.toString() || '';
    
    // For baseMint/quoteMint we need to derive from other sources or pass them
    // These may not exist on the direct pool state object
    const derivedBaseMint = baseMint || '';
    const quoteMint = 'So11111111111111111111111111111111111111112'; // SOL is typically quote

    if (!derivedBaseMint) {
      log.warn({ poolAddress }, 'Cannot sync pool without baseMint');
      return null;
    }

    // Register or update pool
    const pool = await registerPool({
      poolAddress,
      baseMint: derivedBaseMint,
      quoteMint,
      configKey,
      creator,
    });

    return pool;
  } catch (error) {
    log.error({ error, poolAddress }, 'Failed to sync pool from chain');
    throw error;
  }
}

/**
 * Get pool summary with fee stats
 */
export async function getPoolSummary(): Promise<
  Array<{
    id: string;
    pool_address: string;
    name: string | null;
    symbol: string | null;
    status: string;
    created_at: string;
    total_fees_collected: number;
    claim_count: number;
    last_claim_at: string | null;
  }>
> {
  const supabase = getSupabaseUntyped();

  const { data, error } = await supabase.from('pool_summary').select('*');

  if (error) {
    log.error({ error }, 'Failed to fetch pool summary');
    throw new Error(`Failed to fetch pool summary: ${error.message}`);
  }

  return data || [];
}
