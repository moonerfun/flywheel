/**
 * Metadata update script - fetches and updates token metadata for all pools
 * Uses the same API endpoints as the frontend for consistency
 * 
 * Usage: 
 *   pnpm metadata          - Update pools missing metadata
 *   pnpm metadata --force  - Force update ALL pools
 *   pnpm metadata --test   - Test mode - show what would be updated
 */

import { getSupabaseUntyped } from '../db/index.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ script: 'metadata' });

// API endpoints
const JUPITER_DATAPI = 'https://datapi.jup.ag';

const forceUpdate = process.argv.includes('--force');
const testMode = process.argv.includes('--test');

interface TokenMetadata {
  name: string;
  symbol: string;
  icon?: string;
  decimals?: number;
  volume24h?: number;
  liquidity?: number;
  holderCount?: number;
  twitter?: string;
  telegram?: string;
  website?: string;
}

async function fetchTokenMetadata(mintAddress: string): Promise<TokenMetadata | null> {
  // 1. Try Jupiter datapi (same API frontend uses) - this works for all tokens that have traded
  try {
    const response = await fetch(`${JUPITER_DATAPI}/v1/pools?assetIds=${mintAddress}`);
    if (response.ok) {
      const data = await response.json();
      if (data.pools && data.pools.length > 0) {
        const pool = data.pools[0];
        if (pool.baseAsset?.name && pool.baseAsset?.symbol) {
          console.log(`   📍 Found via Jupiter datapi`);
          return {
            name: pool.baseAsset.name,
            symbol: pool.baseAsset.symbol,
            icon: pool.baseAsset.icon,
            decimals: pool.baseAsset.decimals,
            volume24h: pool.volume24h,
            liquidity: pool.baseAsset.liquidity,
            holderCount: pool.baseAsset.holderCount,
            twitter: pool.baseAsset.twitter,
            telegram: pool.baseAsset.telegram,
            website: pool.baseAsset.website,
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
        console.log(`   📍 Found via Jupiter token list`);
        return {
          name: data.name,
          symbol: data.symbol,
          icon: data.logoURI,
          decimals: data.decimals,
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
        if (pair.baseToken?.name && pair.baseToken?.symbol) {
          console.log(`   📍 Found via DexScreener`);
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
          id: 'metadata-fetch',
          method: 'getAsset',
          params: { id: mintAddress },
        }),
      });
      
      if (heliusResponse.ok) {
        const heliusData = await heliusResponse.json();
        if (heliusData.result?.content?.metadata?.name && heliusData.result?.content?.metadata?.symbol) {
          console.log(`   📍 Found via Helius DAS`);
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
  console.log('📝 Token Metadata Updater\n');
  
  if (testMode) {
    console.log('🧪 TEST MODE - No changes will be made\n');
  }
  if (forceUpdate) {
    console.log('⚡ FORCE MODE - Will update all pools\n');
  }

  const supabase = getSupabaseUntyped();

  // Get all pools
  const { data: pools, error } = await supabase
    .from('flywheel_pools')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to fetch pools:', error.message);
    process.exit(1);
  }

  if (!pools || pools.length === 0) {
    console.log('No pools found in database');
    return;
  }

  console.log(`Found ${pools.length} total pools\n`);

  // Filter pools needing update
  const poolsToUpdate = forceUpdate ? pools : pools.filter(pool => 
    !pool.name || 
    !pool.symbol || 
    pool.name === 'Unknown' || 
    pool.symbol === '???' ||
    pool.name?.trim() === '' ||
    pool.symbol?.trim() === ''
  );

  if (poolsToUpdate.length === 0) {
    console.log('✅ All pools have metadata!');
    console.log('\nCurrent pools:');
    pools.slice(0, 10).forEach(p => {
      console.log(`   ${p.symbol || '???'} - ${p.name || 'Unknown'} (${p.base_mint.slice(0, 8)}...)`);
    });
    if (pools.length > 10) {
      console.log(`   ... and ${pools.length - 10} more`);
    }
    return;
  }

  console.log(`Will update ${poolsToUpdate.length} pools\n`);

  let updated = 0;
  let failed = 0;
  let notFound = 0;

  for (const pool of poolsToUpdate) {
    console.log(`\n🔍 ${pool.base_mint.slice(0, 12)}...`);
    console.log(`   Current: ${pool.symbol || '(none)'} - ${pool.name || '(none)'}`);

    const metadata = await fetchTokenMetadata(pool.base_mint);

    if (metadata) {
      console.log(`   New:     ${metadata.symbol} - ${metadata.name}`);
      if (metadata.icon) {
        console.log(`   Icon:    ${metadata.icon.slice(0, 50)}...`);
      }
      if (metadata.volume24h) {
        console.log(`   Volume:  $${metadata.volume24h.toLocaleString()}`);
      }
      
      if (!testMode) {
        // Build update object with all available fields
        const updateData: Record<string, unknown> = {
          name: metadata.name,
          symbol: metadata.symbol,
          updated_at: new Date().toISOString(),
        };
        
        // Add optional fields if available
        if (metadata.icon) updateData.icon = metadata.icon;
        if (metadata.volume24h !== undefined) updateData.volume_24h = metadata.volume24h;
        if (metadata.liquidity !== undefined) updateData.liquidity = metadata.liquidity;
        if (metadata.holderCount !== undefined) updateData.holder_count = metadata.holderCount;
        if (metadata.twitter) updateData.twitter = metadata.twitter;
        if (metadata.telegram) updateData.telegram = metadata.telegram;
        if (metadata.website) updateData.website = metadata.website;

        const { error: updateError } = await supabase
          .from('flywheel_pools')
          .update(updateData)
          .eq('id', pool.id);

        if (updateError) {
          console.log(`   ❌ Failed to update: ${updateError.message}`);
          failed++;
        } else {
          console.log(`   ✅ Updated!`);
          updated++;
        }
      } else {
        console.log(`   📋 Would update (test mode)`);
        updated++;
      }
    } else {
      console.log(`   ⚠️ No metadata found`);
      notFound++;
    }

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  console.log('\n' + '='.repeat(50));
  console.log('📊 SUMMARY');
  console.log('='.repeat(50));
  console.log(`   Updated:   ${updated}`);
  console.log(`   Not found: ${notFound}`);
  console.log(`   Failed:    ${failed}`);
  console.log('='.repeat(50));
}

main().catch((error) => {
  console.error('Script failed:', error);
  process.exit(1);
});
