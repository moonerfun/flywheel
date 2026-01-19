/**
 * Marketcap update script - updates marketcap data for all pools
 * Usage: pnpm marketcap
 */

import 'dotenv/config';
import { updateAllMarketcaps, getBuybackAllocations } from '../services/marketcap.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ script: 'marketcap' });

async function main() {
  console.log('📈 Starting marketcap update...\n');

  const result = await updateAllMarketcaps();

  console.log('📊 Marketcap Update Results:');
  console.log('─'.repeat(50));
  console.log(`  Pools updated:     ${result.poolsUpdated}`);
  console.log(`  Pools failed:      ${result.poolsFailed}`);
  console.log(`  Total marketcap:   $${result.totalMarketcap.toLocaleString()}`);

  if (result.errors.length > 0) {
    console.log('\n⚠️  Errors:');
    for (const err of result.errors.slice(0, 5)) {
      console.log(`   - ${err.poolAddress}: ${err.error}`);
    }
    if (result.errors.length > 5) {
      console.log(`   ... and ${result.errors.length - 5} more`);
    }
  }

  // Show updated allocations
  console.log('\n📊 Updated Buyback Allocations:');
  console.log('─'.repeat(50));
  const allocations = await getBuybackAllocations();
  for (const alloc of allocations.slice(0, 10)) {
    const name = alloc.pool.symbol || alloc.pool.name || alloc.pool.base_mint.slice(0, 8);
    console.log(`  ${name}: ${alloc.allocationPercent.toFixed(2)}% ($${alloc.pool.current_marketcap_usd.toLocaleString()} mcap)`);
  }
  if (allocations.length > 10) {
    console.log(`  ... and ${allocations.length - 10} more pools`);
  }

  console.log('\n✅ Marketcap update complete!');
}

main().catch((error) => {
  log.error({ error }, 'Marketcap script failed');
  console.error('❌ Marketcap update failed:', error.message);
  process.exit(1);
});
