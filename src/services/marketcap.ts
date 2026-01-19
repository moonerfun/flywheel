import { PublicKey } from '@solana/web3.js';
import { getSupabaseUntyped, type FlywheelPool } from '../db/index.js';
import { getConnection } from '../solana/index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getActivePools, getAllCollectablePools, getMigratedPools } from './registry.js';

const log = logger.child({ module: 'marketcap' });

// Jupiter Price API
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2';

// DexScreener API for marketcap data
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex';

export interface TokenPriceData {
  mint: string;
  price: number;
  priceChange24h?: number;
}

export interface TokenMarketcapData {
  mint: string;
  price: number;
  marketcap: number;
  totalSupply: number;
  circulatingSupply?: number;
  volume24h?: number;
  priceChange24h?: number;
}

export interface MarketcapUpdateResult {
  poolsUpdated: number;
  poolsFailed: number;
  totalMarketcap: number;
  errors: Array<{ poolAddress: string; error: string }>;
}

/**
 * Get token prices from Jupiter
 */
export async function getTokenPrices(mints: string[]): Promise<Map<string, TokenPriceData>> {
  const priceMap = new Map<string, TokenPriceData>();

  if (mints.length === 0) return priceMap;

  try {
    // Jupiter API supports up to 100 tokens per request
    const batchSize = 100;
    for (let i = 0; i < mints.length; i += batchSize) {
      const batch = mints.slice(i, i + batchSize);
      const ids = batch.join(',');

      const response = await fetch(`${JUPITER_PRICE_API}?ids=${ids}`);

      if (!response.ok) {
        log.warn({ status: response.status }, 'Jupiter price API error');
        continue;
      }

      const data = (await response.json()) as {
        data: Record<string, { id: string; price: string }>;
      };

      for (const [mint, priceData] of Object.entries(data.data || {})) {
        priceMap.set(mint, {
          mint,
          price: parseFloat(priceData.price) || 0,
        });
      }
    }

    log.debug({ count: priceMap.size }, 'Fetched token prices from Jupiter');
  } catch (error) {
    log.error({ error }, 'Failed to fetch token prices from Jupiter');
  }

  return priceMap;
}

/**
 * Get token marketcap data from DexScreener
 */
export async function getTokenMarketcapFromDexScreener(
  poolAddress: string
): Promise<TokenMarketcapData | null> {
  try {
    const response = await fetch(`${DEXSCREENER_API}/pairs/solana/${poolAddress}`);

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      pair?: {
        baseToken: { address: string };
        priceUsd: string;
        fdv: number;
        volume: { h24: number };
        priceChange: { h24: number };
      };
    };

    if (!data.pair) {
      return null;
    }

    return {
      mint: data.pair.baseToken.address,
      price: parseFloat(data.pair.priceUsd) || 0,
      marketcap: data.pair.fdv || 0,
      totalSupply: 0, // DexScreener doesn't provide this
      volume24h: data.pair.volume?.h24 || 0,
      priceChange24h: data.pair.priceChange?.h24 || 0,
    };
  } catch (error) {
    log.debug({ error, poolAddress }, 'Failed to fetch from DexScreener');
    return null;
  }
}

/**
 * Get token supply from on-chain
 */
export async function getTokenSupply(mint: string): Promise<{
  totalSupply: number;
  decimals: number;
}> {
  const connection = getConnection();

  try {
    const mintPubkey = new PublicKey(mint);
    const supply = await connection.getTokenSupply(mintPubkey);

    return {
      totalSupply: parseFloat(supply.value.amount) / Math.pow(10, supply.value.decimals),
      decimals: supply.value.decimals,
    };
  } catch (error) {
    log.debug({ error, mint }, 'Failed to get token supply');
    return { totalSupply: 0, decimals: 9 };
  }
}

/**
 * Calculate marketcap from price and supply
 */
export function calculateMarketcap(price: number, totalSupply: number): number {
  return price * totalSupply;
}

/**
 * Update marketcap for a single pool
 */
export async function updatePoolMarketcap(pool: FlywheelPool): Promise<boolean> {
  const supabase = getSupabaseUntyped();

  try {
    // Try DexScreener first (has more complete data)
    let marketcapData = await getTokenMarketcapFromDexScreener(pool.pool_address);

    if (!marketcapData || marketcapData.marketcap === 0) {
      // Fallback to Jupiter price + on-chain supply
      const prices = await getTokenPrices([pool.base_mint]);
      const priceData = prices.get(pool.base_mint);

      if (priceData && priceData.price > 0) {
        const supplyData = await getTokenSupply(pool.base_mint);

        marketcapData = {
          mint: pool.base_mint,
          price: priceData.price,
          marketcap: calculateMarketcap(priceData.price, supplyData.totalSupply),
          totalSupply: supplyData.totalSupply,
        };
      }
    }

    if (!marketcapData) {
      log.debug({ poolAddress: pool.pool_address }, 'No marketcap data available');
      return false;
    }

    // Update pool in database
    const { error } = await supabase
      .from('flywheel_pools')
      .update({
        current_marketcap_usd: marketcapData.marketcap,
        current_price_usd: marketcapData.price,
        total_supply: marketcapData.totalSupply,
        marketcap_updated_at: new Date().toISOString(),
      })
      .eq('id', pool.id);

    if (error) {
      log.error({ error, poolId: pool.id }, 'Failed to update pool marketcap');
      return false;
    }

    // Record marketcap history (for analytics)
    await supabase.from('marketcap_history').insert({
      pool_id: pool.id,
      marketcap_usd: marketcapData.marketcap,
      price_usd: marketcapData.price,
    });

    log.debug(
      {
        poolAddress: pool.pool_address,
        marketcap: marketcapData.marketcap,
        price: marketcapData.price,
      },
      'Updated pool marketcap'
    );

    return true;
  } catch (error) {
    log.error({ error, poolAddress: pool.pool_address }, 'Failed to update pool marketcap');
    return false;
  }
}

/**
 * Update marketcap for all active pools
 */
export async function updateAllMarketcaps(): Promise<MarketcapUpdateResult> {
  const supabase = getSupabaseUntyped();

  log.info('Starting marketcap update for all pools');

  const result: MarketcapUpdateResult = {
    poolsUpdated: 0,
    poolsFailed: 0,
    totalMarketcap: 0,
    errors: [],
  };

  try {
    // Update marketcap for ALL pools (active + migrated)
    const pools = await getAllCollectablePools();

    log.info({ poolCount: pools.length }, 'Updating marketcap for pools');

    for (const pool of pools) {
      const success = await updatePoolMarketcap(pool);

      if (success) {
        result.poolsUpdated++;
      } else {
        result.poolsFailed++;
        result.errors.push({
          poolAddress: pool.pool_address,
          error: 'Failed to fetch marketcap data',
        });
      }

      // Rate limiting - small delay between requests
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Update marketcap ranks
    await supabase.rpc('update_marketcap_ranks');

    // Calculate total marketcap (both active and migrated)
    const { data: stats } = await supabase
      .from('flywheel_pools')
      .select('current_marketcap_usd')
      .in('status', ['active', 'migrated']);

    if (stats) {
      result.totalMarketcap = (stats as Array<{ current_marketcap_usd: number }>).reduce(
        (sum, p) => sum + (p.current_marketcap_usd || 0),
        0
      );
    }

    // Update global stats
    await supabase
      .from('flywheel_stats')
      .update({
        total_marketcap_usd: result.totalMarketcap,
        avg_marketcap_usd: pools.length > 0 ? result.totalMarketcap / pools.length : 0,
        total_unique_tokens: pools.length,
      })
      .eq('id', 1);

    log.info(
      {
        updated: result.poolsUpdated,
        failed: result.poolsFailed,
        totalMarketcap: result.totalMarketcap,
      },
      'Marketcap update completed'
    );
  } catch (error) {
    log.error({ error }, 'Marketcap update failed');
  }

  return result;
}

/**
 * Get buyback allocations based on marketcap
 * Higher marketcap = higher allocation percentage
 * NOTE: Only migrated tokens participate in buyback - non-migrated tokens do not benefit from the flywheel effect
 */
export async function getBuybackAllocations(): Promise<
  Array<{
    pool: FlywheelPool;
    allocationPercent: number;
    allocatedSol: number;
  }>
> {
  const supabase = getSupabaseUntyped();

  try {
    // Get allocation from database view
    const { data: allocations } = await supabase
      .from('buyback_allocations')
      .select('*');

    // Only include migrated pools for buyback allocations
    const migratedPools = await getMigratedPools();
    const migratedPoolIds = new Set(migratedPools.map((p) => p.id));

    if (!allocations || allocations.length === 0) {
      // Fallback: equal distribution across migrated pools only
      const equalPercent = migratedPools.length > 0 ? 100 / migratedPools.length : 0;

      log.info(
        { migratedPoolCount: migratedPools.length },
        'Using equal distribution for migrated pools buyback'
      );

      return migratedPools.map((pool) => ({
        pool,
        allocationPercent: equalPercent,
        allocatedSol: 0, // Will be calculated when executing
      }));
    }

    // Build pool map from migrated pools only
    const poolMap = new Map(migratedPools.map((p) => [p.id, p]));

    // Filter allocations to only include migrated pools
    const filteredAllocations = (allocations as Array<{ pool_id: string; allocation_percent: number }>)
      .filter((a) => migratedPoolIds.has(a.pool_id) && poolMap.has(a.pool_id));

    // Recalculate percentages so they sum to 100% for migrated pools only
    const totalPercent = filteredAllocations.reduce((sum, a) => sum + a.allocation_percent, 0);
    const scaleFactor = totalPercent > 0 ? 100 / totalPercent : 0;

    log.info(
      { migratedPoolCount: filteredAllocations.length, totalPercent, scaleFactor },
      'Calculated buyback allocations for migrated pools'
    );

    return filteredAllocations.map((a) => ({
      pool: poolMap.get(a.pool_id)!,
      allocationPercent: a.allocation_percent * scaleFactor,
      allocatedSol: 0,
    }));
  } catch (error) {
    log.error({ error }, 'Failed to get buyback allocations');

    // Fallback: equal distribution across migrated pools only
    const migratedPools = await getMigratedPools();
    const equalPercent = migratedPools.length > 0 ? 100 / migratedPools.length : 0;

    return migratedPools.map((pool) => ({
      pool,
      allocationPercent: equalPercent,
      allocatedSol: 0,
    }));
  }
}

/**
 * Get top pools by marketcap
 */
export async function getTopPoolsByMarketcap(
  limit: number = 10
): Promise<Array<FlywheelPool & { rank: number }>> {
  const supabase = getSupabaseUntyped();

  const { data, error } = await supabase
    .from('flywheel_pools')
    .select('*')
    .in('status', ['active', 'migrated'])
    .gt('current_marketcap_usd', 0)
    .order('current_marketcap_usd', { ascending: false })
    .limit(limit);

  if (error) {
    log.error({ error }, 'Failed to get top pools by marketcap');
    return [];
  }

  return (data as FlywheelPool[]).map((pool, index) => ({
    ...pool,
    rank: index + 1,
  }));
}
