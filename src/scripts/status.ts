import 'dotenv/config';
import { getSupabaseUntyped } from '../db/index.js';
import { getFlywheelWallet, getWalletBalance } from '../solana/index.js';
import { getActivePools } from '../services/registry.js';
import { getNativeTokenBalance, getTotalBurned } from '../services/burner.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

interface FlywheelStats {
  total_pools: number;
  active_pools: number;
  total_fees_collected_sol: number | null;
  total_sol_used_for_buyback: number | null;
  total_tokens_bought: number | null;
  total_tokens_burned: number | null;
  last_fee_claim_at: string | null;
  last_buyback_at: string | null;
  last_burn_at: string | null;
}

const log = logger.child({ module: 'status-script' });

async function main(): Promise<void> {
  try {
    const wallet = getFlywheelWallet();
    const solBalance = await getWalletBalance();
    const tokenBalance = await getNativeTokenBalance();
    const pools = await getActivePools();
    
    const supabase = getSupabaseUntyped();
    const { data } = await supabase.from('flywheel_stats').select('*').single();
    const stats = data as FlywheelStats | null;

    console.log('\n🎡 Flywheel Status');
    console.log('═'.repeat(50));
    
    console.log('\n📍 Configuration:');
    console.log('─'.repeat(50));
    console.log(`  RPC URL: ${config.solana.rpcUrl}`);
    console.log(`  Native Token: ${config.token.nativeMint}`);
    console.log(`  Min Buyback Threshold: ${config.thresholds.minBuybackSol} SOL`);
    console.log(`  Slippage: ${config.thresholds.slippageBps} bps`);

    console.log('\n💰 Wallet:');
    console.log('─'.repeat(50));
    console.log(`  Address: ${wallet.publicKey.toString()}`);
    console.log(`  SOL Balance: ${solBalance.toFixed(9)} SOL`);
    console.log(`  Native Token Balance: ${tokenBalance.toFixed(9)}`);

    console.log('\n📊 Statistics:');
    console.log('─'.repeat(50));
    if (stats) {
      console.log(`  Total Pools: ${stats.total_pools}`);
      console.log(`  Active Pools: ${stats.active_pools}`);
      console.log(`  Total Fees Collected: ${stats.total_fees_collected_sol?.toFixed(9) || '0'} SOL`);
      console.log(`  Total SOL Used for Buyback: ${stats.total_sol_used_for_buyback?.toFixed(9) || '0'} SOL`);
      console.log(`  Total Tokens Bought: ${stats.total_tokens_bought?.toFixed(9) || '0'}`);
      console.log(`  Total Tokens Burned: ${stats.total_tokens_burned?.toFixed(9) || '0'}`);
      
      if (stats.last_fee_claim_at) {
        console.log(`  Last Fee Claim: ${new Date(stats.last_fee_claim_at).toLocaleString()}`);
      }
      if (stats.last_buyback_at) {
        console.log(`  Last Buyback: ${new Date(stats.last_buyback_at).toLocaleString()}`);
      }
      if (stats.last_burn_at) {
        console.log(`  Last Burn: ${new Date(stats.last_burn_at).toLocaleString()}`);
      }
    } else {
      console.log('  No stats available yet');
    }

    console.log('\n🏊 Active Pools:');
    console.log('─'.repeat(50));
    if (pools.length === 0) {
      console.log('  No active pools registered');
    } else {
      for (const pool of pools.slice(0, 10)) {
        const name = pool.name || pool.symbol || 'Unknown';
        console.log(`  • ${name} - ${pool.pool_address.slice(0, 16)}...`);
      }
      if (pools.length > 10) {
        console.log(`  ... and ${pools.length - 10} more`);
      }
    }

    console.log('\n⏰ Scheduler:');
    console.log('─'.repeat(50));
    console.log(`  Fee Collection: ${config.scheduler.feeCollectionCron}`);
    console.log(`  Buyback: ${config.scheduler.buybackCron}`);
    console.log(`  Burn After Buyback: ${config.scheduler.burnAfterBuyback ? 'Yes' : 'No'}`);

    console.log('\n' + '═'.repeat(50));
  } catch (error) {
    log.error({ error }, 'Status check failed');
    console.error('Failed to get status:', error);
    process.exit(1);
  }
}

main();
