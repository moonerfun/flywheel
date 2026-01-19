import 'dotenv/config';
import { collectAllFees } from '../services/collector.js';
import { collectAllDammV2Fees } from '../services/collector-dammv2.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ module: 'collect-script' });

async function main(): Promise<void> {
  log.info('Starting fee collection');

  try {
    // Collect from DBC pools (partner fees)
    console.log('\n📊 DBC Pool Fee Collection:');
    console.log('─'.repeat(40));
    const dbcResult = await collectAllFees();

    console.log(`Pools Processed: ${dbcResult.totalPoolsProcessed}`);
    console.log(`Successful Claims: ${dbcResult.successfulClaims}`);
    console.log(`Failed Claims: ${dbcResult.failedClaims}`);
    console.log(`Total SOL Collected: ${dbcResult.totalQuoteCollected.toFixed(9)} SOL`);
    console.log('─'.repeat(40));

    if (dbcResult.claims.length > 0) {
      console.log('\nDBC Claim Details:');
      for (const claim of dbcResult.claims) {
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

    // Collect from DAMM v2 pools (LP fees from migrated pools)
    console.log('\n📊 DAMM v2 Pool Fee Collection (Migrated Pools):');
    console.log('─'.repeat(40));
    const dammResult = await collectAllDammV2Fees();

    console.log(`Pools Processed: ${dammResult.totalPoolsProcessed}`);
    console.log(`Successful Claims: ${dammResult.successfulClaims}`);
    console.log(`Failed Claims: ${dammResult.failedClaims}`);
    console.log(`Total SOL Collected: ${dammResult.totalSolCollected.toFixed(9)} SOL`);
    console.log(`Total Tokens Collected: ${dammResult.totalTokensCollected.toFixed(6)}`);
    console.log('─'.repeat(40));

    if (dammResult.claims.length > 0) {
      console.log('\nDAMM v2 Claim Details:');
      for (const claim of dammResult.claims) {
        const status = claim.success ? '✅' : '❌';
        console.log(`  ${status} ${claim.poolAddress.slice(0, 8)}... - ${claim.tokenBAmount} SOL`);
        if (claim.txSignature) {
          console.log(`     TX: ${claim.txSignature}`);
        }
        if (claim.error) {
          console.log(`     Error: ${claim.error}`);
        }
      }
    }

    // Summary
    console.log('\n📊 Total Collection Summary:');
    console.log('─'.repeat(40));
    const totalSol = dbcResult.totalQuoteCollected + dammResult.totalSolCollected;
    console.log(`Total SOL Collected: ${totalSol.toFixed(9)} SOL`);
    console.log('─'.repeat(40));

  } catch (error) {
    log.error({ error }, 'Fee collection failed');
    process.exit(1);
  }
}

main();
