/**
 * Backfill script - ensures all historical pools are in the database with full metadata
 * This addresses the 24h limitation of Jupiter API by maintaining our own database
 * 
 * Usage: pnpm backfill
 * 
 * This script:
 * 1. Discovers all pools on-chain for the platform config key(s)
 * 2. Updates token metadata (name, symbol) from on-chain
 * 3. Updates migration status for graduated pools
 * 4. Updates marketcap data for all active/migrated pools
 */

import { discoverPlatformPools, updateMigrationStatus, syncMissingPools } from '../services/discovery.js';
import { updateAllMarketcaps } from '../services/marketcap.js';
import { getActivePools, getMigratedPools } from '../services/registry.js';
import { getSupabaseUntyped } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { getConnection } from '../solana/index.js';
import { PublicKey } from '@solana/web3.js';

const log = logger.child({ script: 'backfill' });

interface BackfillResult {
  poolsDiscovered: number;
  poolsNew: number;
  metadataUpdated: number;
  migrationsFound: number;
  marketcapsUpdated: number;
  errors: string[];
}

// Jupiter datapi - same API the frontend uses successfully
const JUPITER_DATAPI = 'https://datapi.jup.ag';

// Check for --force flag to update all metadata (defined early so updateTokenMetadata can use it)
const forceUpdate = process.argv.includes('--force');

async function updateTokenMetadata(): Promise<{ updated: number; errors: number; skipped: number }> {
  const supabase = getSupabaseUntyped();
  let updated = 0;
  let errors = 0;
  let skipped = 0;

  // Get ALL pools
  const { data: pools } = await supabase
    .from('flywheel_pools')
    .select('*');

  if (!pools || pools.length === 0) {
    console.log('   No pools found');
    return { updated: 0, errors: 0, skipped: 0 };
  }

  // Filter pools that need metadata (or all if force mode)
  const poolsNeedingMetadata = forceUpdate ? pools : pools.filter(pool => 
    !pool.name || 
    !pool.symbol || 
    pool.name === 'Unknown' || 
    pool.symbol === '???' ||
    pool.name.trim() === '' ||
    pool.symbol.trim() === ''
  );

  if (poolsNeedingMetadata.length === 0) {
    console.log('   All pools have metadata');
    skipped = pools.length;
    return { updated: 0, errors: 0, skipped };
  }

  console.log(`   Found ${poolsNeedingMetadata.length} pools needing metadata update`);

  for (const pool of poolsNeedingMetadata) {
    try {
      // Fetch token metadata using same API as frontend
      const metadata = await fetchTokenMetadata(pool.base_mint);
      
      if (metadata && metadata.name && metadata.symbol) {
        await supabase
          .from('flywheel_pools')
          .update({
            name: metadata.name,
            symbol: metadata.symbol,
            updated_at: new Date().toISOString(),
          })
          .eq('id', pool.id);
        
        updated++;
        console.log(`   ✓ Updated ${metadata.symbol} (${metadata.name})`);
      } else {
        skipped++;
        console.log(`   ⚠ No metadata found for ${pool.base_mint.slice(0, 8)}...`);
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      errors++;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`   ✗ Error for ${pool.base_mint.slice(0, 8)}: ${errorMsg}`);
      log.warn({ error, poolId: pool.id }, 'Failed to fetch token metadata');
    }
  }

  return { updated, errors, skipped };
}

interface TokenMetadata {
  name: string;
  symbol: string;
  icon?: string;
}

async function fetchTokenMetadata(mintAddress: string): Promise<TokenMetadata | null> {
  // Try multiple sources in order of reliability

  // 1. Try Jupiter datapi (same API frontend uses) - this works for all tokens that have traded
  try {
    const response = await fetch(`${JUPITER_DATAPI}/v1/pools?assetIds=${mintAddress}`);
    if (response.ok) {
      const data = await response.json();
      if (data.pools && data.pools.length > 0) {
        const pool = data.pools[0];
        if (pool.baseAsset) {
          return {
            name: pool.baseAsset.name,
            symbol: pool.baseAsset.symbol,
            icon: pool.baseAsset.icon,
          };
        }
      }
    }
  } catch (error) {
    log.debug({ error, mintAddress }, 'Jupiter datapi failed');
  }

  // 2. Try Jupiter Token List API
  try {
    const response = await fetch(`https://tokens.jup.ag/token/${mintAddress}`);
    if (response.ok) {
      const data = await response.json();
      if (data.name && data.symbol) {
        return {
          name: data.name,
          symbol: data.symbol,
          icon: data.logoURI,
        };
      }
    }
  } catch (error) {
    log.debug({ error, mintAddress }, 'Jupiter token API failed');
  }

  // 3. Try DexScreener API
  try {
    const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
    if (dexResponse.ok) {
      const dexData = await dexResponse.json();
      if (dexData.pairs && dexData.pairs.length > 0) {
        const pair = dexData.pairs[0];
        if (pair.baseToken) {
          return {
            name: pair.baseToken.name,
            symbol: pair.baseToken.symbol,
          };
        }
      }
    }
  } catch (error) {
    log.debug({ error, mintAddress }, 'DexScreener API failed');
  }

  // 4. Try Helius DAS API (if configured)
  if (process.env.HELIUS_API_KEY) {
    try {
      const heliusResponse = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'my-id',
          method: 'getAsset',
          params: { id: mintAddress },
        }),
      });
      
      if (heliusResponse.ok) {
        const heliusData = await heliusResponse.json();
        if (heliusData.result?.content?.metadata) {
          const meta = heliusData.result.content.metadata;
          return {
            name: meta.name,
            symbol: meta.symbol,
            icon: heliusData.result.content.links?.image,
          };
        }
      }
    } catch (error) {
      log.debug({ error, mintAddress }, 'Helius API failed');
    }
  }

  return null;
}

async function main() {
  console.log('🔄 Starting comprehensive backfill...\n');
  if (forceUpdate) {
    console.log('⚡ Force mode enabled - will update ALL pool metadata\n');
  }

  const result: BackfillResult = {
    poolsDiscovered: 0,
    poolsNew: 0,
    metadataUpdated: 0,
    migrationsFound: 0,
    marketcapsUpdated: 0,
    errors: [],
  };

  try {
    // Step 1: Discover pools on-chain
    console.log('📡 Step 1: Discovering pools from on-chain...');
    const discovery = await discoverPlatformPools();
    result.poolsDiscovered = discovery.poolsDiscovered;
    result.poolsNew = discovery.poolsNew;
    console.log(`   Found ${discovery.poolsDiscovered} pools, ${discovery.poolsNew} new`);

    // Step 2: Sync any missing pools
    console.log('\n🔍 Step 2: Syncing missing pools...');
    const syncResult = await syncMissingPools();
    console.log(`   Synced ${syncResult.synced} pools, ${syncResult.errors} errors`);

    // Step 3: Update token metadata
    console.log('\n📝 Step 3: Updating token metadata...');
    const metadata = await updateTokenMetadata();
    result.metadataUpdated = metadata.updated;
    console.log(`   Updated ${metadata.updated} tokens`);

    // Step 4: Check migration status
    console.log('\n🚀 Step 4: Checking migration status...');
    const migrations = await updateMigrationStatus();
    result.migrationsFound = migrations.migratedFound;
    console.log(`   Found ${migrations.migratedFound} newly migrated pools`);

    // Step 5: Update marketcaps
    console.log('\n💰 Step 5: Updating marketcaps...');
    const mcResult = await updateAllMarketcaps();
    result.marketcapsUpdated = mcResult.poolsUpdated;
    console.log(`   Updated ${mcResult.poolsUpdated} marketcaps`);
    if (mcResult.poolsFailed > 0) {
      console.log(`   Failed: ${mcResult.poolsFailed}`);
    }

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('📊 BACKFILL SUMMARY');
    console.log('='.repeat(50));
    console.log(`   Pools discovered:     ${result.poolsDiscovered}`);
    console.log(`   New pools registered: ${result.poolsNew}`);
    console.log(`   Metadata updated:     ${result.metadataUpdated}`);
    console.log(`   Migrations found:     ${result.migrationsFound}`);
    console.log(`   Marketcaps updated:   ${result.marketcapsUpdated}`);
    console.log('='.repeat(50));
    console.log('\n✅ Backfill complete!');

    // Get current pool counts
    const activePools = await getActivePools();
    const migratedPools = await getMigratedPools();
    
    console.log(`\n📈 Current Database State:`);
    console.log(`   Active (non-graduated) pools: ${activePools.length}`);
    console.log(`   Migrated (graduated) pools:   ${migratedPools.length}`);
    console.log(`   Total pools:                  ${activePools.length + migratedPools.length}`);

  } catch (error) {
    log.error({ error }, 'Backfill failed');
    console.error('\n❌ Backfill failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
