import 'dotenv/config';
import { registerPool, syncPoolFromChain } from '../services/registry.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ module: 'register-script' });

function parseArgs(): { poolAddress?: string; sync?: boolean } {
  const args = process.argv.slice(2);
  const result: { poolAddress?: string; sync?: boolean } = {};

  for (const arg of args) {
    if (arg.startsWith('--pool=')) {
      result.poolAddress = arg.split('=')[1];
    } else if (arg === '--sync') {
      result.sync = true;
    } else if (!arg.startsWith('--')) {
      result.poolAddress = arg;
    }
  }

  return result;
}

async function main(): Promise<void> {
  const { poolAddress, sync } = parseArgs();

  if (!poolAddress) {
    console.log('Usage: pnpm register -- --pool=<pool_address> [--sync]');
    console.log('');
    console.log('Options:');
    console.log('  --pool=<address>  Pool address to register');
    console.log('  --sync            Sync pool data from on-chain');
    process.exit(1);
  }

  try {
    console.log(`\n📝 Registering pool: ${poolAddress}`);

    if (sync) {
      console.log('Syncing from on-chain data...');
      const pool = await syncPoolFromChain(poolAddress);
      
      if (pool) {
        console.log('\n✅ Pool registered successfully!');
        console.log('─'.repeat(40));
        console.log(`  ID: ${pool.id}`);
        console.log(`  Address: ${pool.pool_address}`);
        console.log(`  Base Mint: ${pool.base_mint}`);
        console.log(`  Quote Mint: ${pool.quote_mint}`);
        console.log(`  Creator: ${pool.creator}`);
        console.log(`  Status: ${pool.status}`);
        console.log('─'.repeat(40));
      } else {
        console.log('\n❌ Pool not found on-chain');
      }
    } else {
      // Manual registration requires more params
      console.log('\n⚠️  For manual registration, use --sync to fetch data from chain');
      console.log('   Or call the API: POST /pools/register');
    }
  } catch (error) {
    log.error({ error }, 'Registration failed');
    console.error('Failed to register pool:', error);
    process.exit(1);
  }
}

main();
