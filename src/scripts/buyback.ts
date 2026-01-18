import 'dotenv/config';
import { executeBuyback, executeMultiBuyback, shouldExecuteBuyback } from '../services/buyback.js';
import { getBuybackAllocations } from '../services/marketcap.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ module: 'buyback-script' });

async function main(): Promise<void> {
  log.info('Starting buyback');

  try {
    // Parse command line args
    const args = process.argv.slice(2);
    const isMultiToken = args.includes('--multi') || args.includes('-m');
    const showAllocations = args.includes('--allocations') || args.includes('-a');

    // Check if buyback is needed
    const check = await shouldExecuteBuyback();
    
    console.log('\n💰 Buyback Check:');
    console.log('─'.repeat(40));
    console.log(`Available Balance: ${check.balance.toFixed(9)} SOL`);
    console.log(`Threshold: ${check.threshold} SOL`);
    console.log(`Should Buyback: ${check.shouldBuyback ? 'Yes' : 'No'}`);
    console.log('─'.repeat(40));

    // Show allocations if requested
    if (showAllocations) {
      console.log('\n📊 Buyback Allocations (by marketcap):');
      const allocations = await getBuybackAllocations();
      for (const alloc of allocations) {
        console.log(`  ${alloc.pool.symbol || alloc.pool.base_mint.slice(0, 8)}: ${alloc.allocationPercent.toFixed(2)}% ($${alloc.pool.current_marketcap_usd.toFixed(0)} mcap)`);
      }
      console.log('');
    }

    if (!check.shouldBuyback) {
      console.log('\n⚠️  Insufficient balance for buyback. Exiting.');
      return;
    }

    // Get optional amount from command line
    let amount: number | undefined;
    const amountArg = args.find(arg => arg.startsWith('--amount='));
    if (amountArg) {
      amount = parseFloat(amountArg.split('=')[1] || '0');
    }

    if (isMultiToken) {
      console.log(`\n🔄 Executing MULTI-TOKEN buyback${amount ? ` for ${amount} SOL` : ' (full balance)'}...`);
      const result = await executeMultiBuyback(amount);

      console.log('\n📊 Multi-Token Buyback Results:');
      console.log('─'.repeat(40));
      console.log(`Success: ${result.success ? '✅' : '❌'}`);
      console.log(`Total SOL Used: ${result.totalSolUsed.toFixed(9)} SOL`);
      console.log(`Pools Successful: ${result.poolsSuccessful}`);
      console.log(`Pools Failed: ${result.poolsFailed}`);
      console.log('');
      for (const r of result.results) {
        const status = r.success ? '✅' : '❌';
        console.log(`  ${status} ${r.pool.symbol || r.pool.base_mint.slice(0, 8)}: ${r.tokensBought.toFixed(4)} tokens (${r.solAllocated.toFixed(4)} SOL)`);
      }
      console.log('─'.repeat(40));
    } else {
      console.log(`\n🔄 Executing single-token buyback${amount ? ` for ${amount} SOL` : ' (full balance)'}...`);
      console.log('(Use --multi for multi-token proportional buyback)');
      
      const result = await executeBuyback(amount);

      console.log('\n📊 Buyback Results:');
      console.log('─'.repeat(40));
      console.log(`Success: ${result.success ? '✅' : '❌'}`);
      console.log(`SOL Spent: ${result.solAmount.toFixed(9)} SOL`);
      console.log(`Tokens Received: ${result.tokenAmount.toFixed(9)}`);
      console.log(`Price Per Token: ${result.pricePerToken.toFixed(9)} SOL`);
      
      if (result.txSignature) {
        console.log(`TX: ${result.txSignature}`);
      }
      if (result.error) {
        console.log(`Error: ${result.error}`);
      }
      console.log('─'.repeat(40));
    }
  } catch (error) {
    log.error({ error }, 'Buyback failed');
    process.exit(1);
  }
}

main();
