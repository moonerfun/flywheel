/**
 * Manual discovery script - discovers new pools and updates migration status
 * Usage: pnpm discover
 */

import { discoverPlatformPools, updateMigrationStatus } from '../services/discovery.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ script: 'discover' });

async function main() {
  console.log('🔍 Starting pool discovery and migration check...\n');

  // Step 1: Discover new pools
  console.log('📡 Discovering new pools from platform config...');
  const discoveryResult = await discoverPlatformPools();

  console.log(`\n📊 Discovery Results:`);
  console.log(`   Pools found on-chain: ${discoveryResult.poolsDiscovered}`);
  console.log(`   New pools registered: ${discoveryResult.poolsNew}`);
  console.log(`   Already registered:   ${discoveryResult.poolsExisting}`);
  console.log(`   Errors:               ${discoveryResult.errors.length}`);

  if (discoveryResult.errors.length > 0) {
    console.log('\n⚠️  Errors:');
    for (const err of discoveryResult.errors.slice(0, 5)) {
      console.log(`   - ${err.poolAddress}: ${err.error}`);
    }
    if (discoveryResult.errors.length > 5) {
      console.log(`   ... and ${discoveryResult.errors.length - 5} more`);
    }
  }

  // Step 2: Check migration status
  console.log('\n🔄 Checking pool migration status...');
  const migrationResult = await updateMigrationStatus();

  console.log(`\n📊 Migration Check Results:`);
  console.log(`   Pools checked:        ${migrationResult.checked}`);
  console.log(`   Newly migrated:       ${migrationResult.migratedFound}`);
  console.log(`   DAMM v2 pools found:  ${migrationResult.dammPoolsFound}`);
  console.log(`   Errors:               ${migrationResult.errors}`);

  console.log('\n✅ Discovery complete!');
}

main().catch((error) => {
  log.error({ error }, 'Discovery script failed');
  console.error('❌ Discovery failed:', error.message);
  process.exit(1);
});
