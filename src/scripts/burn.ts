import 'dotenv/config';
import { burnTokens, burnAllTokens, getNativeTokenBalance, getTotalBurned } from '../services/burner.js';
import { getActivePools } from '../services/registry.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ module: 'burn-script' });

async function main(): Promise<void> {
  log.info('Starting burn');

  try {
    // Parse command line args
    const args = process.argv.slice(2);
    const isMultiToken = args.includes('--multi') || args.includes('-m');

    if (isMultiToken) {
      // Multi-token burn mode
      const pools = await getActivePools();
      console.log('\n🔥 Multi-Token Burn Status:');
      console.log('─'.repeat(40));
      console.log(`Active Pools: ${pools.length}`);
      console.log('─'.repeat(40));

      console.log('\n🔥 Executing multi-token burn...');
      const result = await burnAllTokens();

      console.log('\n📊 Multi-Token Burn Results:');
      console.log('─'.repeat(40));
      console.log(`Success: ${result.success ? '✅' : '❌'}`);
      console.log(`Total Tokens Burned: ${result.totalBurned.toFixed(9)}`);
      console.log(`Pools Successful: ${result.poolsSuccessful}`);
      console.log(`Pools Failed: ${result.poolsFailed}`);
      console.log('');
      for (const r of result.results) {
        const status = r.success ? '✅' : '❌';
        console.log(`  ${status} ${r.pool.symbol || r.pool.base_mint.slice(0, 8)}: ${r.amount.toFixed(4)} tokens burned`);
      }
      console.log('─'.repeat(40));
    } else {
      // Single token burn mode (legacy)
      const balance = await getNativeTokenBalance();
      const totalBurned = await getTotalBurned();

      console.log('\n🔥 Burn Status:');
      console.log('─'.repeat(40));
      console.log(`Native Token: ${config.token.nativeMint || '(multi-token mode)'}`);
      console.log(`Current Balance: ${balance.toFixed(9)}`);
      console.log(`Total Burned (historical): ${totalBurned.toFixed(9)}`);
      console.log('(Use --multi for multi-token burn)');
      console.log('─'.repeat(40));

      if (balance <= 0) {
        console.log('\n⚠️  No tokens to burn. Exiting.');
        return;
      }

      // Get optional amount from command line
      let amount: number | undefined;
      let buybackId: string | undefined;

      const amountArg = args.find(arg => arg.startsWith('--amount='));
      if (amountArg) {
        amount = parseFloat(amountArg.split('=')[1] || '0');
      }

      const buybackArg = args.find(arg => arg.startsWith('--buyback-id='));
      if (buybackArg) {
        buybackId = buybackArg.split('=')[1];
      }

      console.log(`\n🔥 Executing burn${amount ? ` for ${amount} tokens` : ' (full balance)'}...`);

      const result = await burnTokens(amount, buybackId);

      console.log('\n📊 Burn Results:');
      console.log('─'.repeat(40));
      console.log(`Success: ${result.success ? '✅' : '❌'}`);
      console.log(`Tokens Burned: ${result.amount.toFixed(9)}`);

      if (result.txSignature) {
        console.log(`TX: ${result.txSignature}`);
      }
      if (result.error) {
        console.log(`Error: ${result.error}`);
      }
      console.log('─'.repeat(40));
    }
  } catch (error) {
    log.error({ error }, 'Burn failed');
    process.exit(1);
  }
}

main();
 
