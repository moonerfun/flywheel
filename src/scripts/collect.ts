import 'dotenv/config';
import { collectAllFees } from '../services/collector.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ module: 'collect-script' });

async function main(): Promise<void> {
  log.info('Starting fee collection');

  try {
    const result = await collectAllFees();

    console.log('\n📊 Fee Collection Results:');
    console.log('─'.repeat(40));
    console.log(`Pools Processed: ${result.totalPoolsProcessed}`);
    console.log(`Successful Claims: ${result.successfulClaims}`);
    console.log(`Failed Claims: ${result.failedClaims}`);
    console.log(`Total SOL Collected: ${result.totalQuoteCollected.toFixed(9)} SOL`);
    console.log('─'.repeat(40));

    if (result.claims.length > 0) {
      console.log('\nClaim Details:');
      for (const claim of result.claims) {
        const status = claim.success ? '✅' : '❌';
        console.log(`  ${status} ${claim.poolAddress.slice(0, 8)}... - ${claim.quoteAmount} SOL`);
        if (claim.txSignature) {
          console.log(`     TX: ${claim.txSignature}`);
        }
        if (claim.error) {
          console.log(`     Error: ${claim.error}`);
        }
      }
    }
  } catch (error) {
    log.error({ error }, 'Fee collection failed');
    process.exit(1);
  }
}

main();
