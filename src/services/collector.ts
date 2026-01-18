import { PublicKey, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { getSupabaseUntyped, type FeeClaimInsert, type FlywheelPool } from '../db/index.js';
import { getConnection, getFlywheelWallet } from '../solana/index.js';
import { getActivePools } from './registry.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ module: 'collector' });

export interface FeeClaimResult {
  poolAddress: string;
  quoteAmount: number;
  baseAmount: number;
  txSignature: string;
  success: boolean;
  error?: string;
}

export interface CollectionResult {
  totalPoolsProcessed: number;
  successfulClaims: number;
  failedClaims: number;
  totalQuoteCollected: number;
  claims: FeeClaimResult[];
}

/**
 * Check claimable fees for a pool
 */
export async function getClaimableFees(
  poolAddress: string
): Promise<{ quoteAmount: number; baseAmount: number }> {
  const connection = getConnection();

  try {
    const client = new DynamicBondingCurveClient(connection, 'confirmed');
    const poolPubkey = new PublicKey(poolAddress);

    // Get pool state using the state namespace
    const poolState = await client.state.getPool(poolPubkey);
    if (!poolState) {
      throw new Error('Pool not found');
    }

    // Get fee metrics from the pool
    const feeMetrics = await client.state.getPoolFeeMetrics(poolPubkey);

    return {
      quoteAmount: feeMetrics?.current?.partnerQuoteFee ? Number(feeMetrics.current.partnerQuoteFee) / 1e9 : 0,
      baseAmount: feeMetrics?.current?.partnerBaseFee ? Number(feeMetrics.current.partnerBaseFee) / 1e9 : 0,
    };
  } catch (error) {
    log.error({ error, poolAddress }, 'Failed to get claimable fees');
    return { quoteAmount: 0, baseAmount: 0 };
  }
}

/**
 * Claim partner fees from a single pool
 */
export async function claimFeesFromPool(pool: FlywheelPool): Promise<FeeClaimResult> {
  const connection = getConnection();
  const wallet = getFlywheelWallet();
  const supabase = getSupabaseUntyped();

  const result: FeeClaimResult = {
    poolAddress: pool.pool_address,
    quoteAmount: 0,
    baseAmount: 0,
    txSignature: '',
    success: false,
  };

  try {
    log.info({ poolAddress: pool.pool_address }, 'Claiming fees from pool');

    const client = new DynamicBondingCurveClient(connection, 'confirmed');
    const poolPubkey = new PublicKey(pool.pool_address);

    // Check claimable fees first
    const claimable = await getClaimableFees(pool.pool_address);

    if (claimable.quoteAmount <= 0 && claimable.baseAmount <= 0) {
      log.info({ poolAddress: pool.pool_address }, 'No fees to claim');
      result.success = true;
      return result;
    }

    // Build claim transaction using the partner namespace
    // Use BN instead of BigInt as the SDK expects BN type
    const BN = (await import('bn.js')).default;
    const claimTx = await client.partner.claimPartnerTradingFee({
      feeClaimer: wallet.publicKey,
      pool: poolPubkey,
      maxQuoteAmount: claimable.quoteAmount > 0 ? new BN(Math.floor(claimable.quoteAmount * 1e9)) : new BN(0),
      maxBaseAmount: claimable.baseAmount > 0 ? new BN(Math.floor(claimable.baseAmount * 1e9)) : new BN(0),
      payer: wallet.publicKey,
    });

    // Send transaction
    const txSignature = await sendAndConfirmTransaction(connection, claimTx, [wallet], {
      commitment: 'confirmed',
    });

    result.quoteAmount = claimable.quoteAmount;
    result.baseAmount = claimable.baseAmount;
    result.txSignature = txSignature;
    result.success = true;

    // Record in database
    const feeClaimData: FeeClaimInsert = {
      pool_id: pool.id,
      pool_address: pool.pool_address,
      quote_amount: claimable.quoteAmount,
      base_amount: claimable.baseAmount,
      tx_signature: txSignature,
      fee_type: 'partner',
    };

    await supabase.from('fee_claims').insert(feeClaimData);

    // Log operation
    await supabase.from('operation_logs').insert({
      operation_type: 'fee_claim',
      status: 'completed',
      tx_signature: txSignature,
      details: {
        pool_address: pool.pool_address,
        quote_amount: claimable.quoteAmount,
        base_amount: claimable.baseAmount,
      },
    });

    log.info(
      {
        poolAddress: pool.pool_address,
        quoteAmount: claimable.quoteAmount,
        txSignature,
      },
      'Fees claimed successfully'
    );

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    result.error = errorMessage;

    log.error({ error, poolAddress: pool.pool_address }, 'Failed to claim fees');

    // Log failed operation
    await supabase.from('operation_logs').insert({
      operation_type: 'fee_claim',
      status: 'failed',
      error_message: errorMessage,
      details: { pool_address: pool.pool_address },
    });

    return result;
  }
}

/**
 * Collect fees from all active pools
 */
export async function collectAllFees(): Promise<CollectionResult> {
  const supabase = getSupabaseUntyped();

  log.info('Starting fee collection from all active pools');

  // Log operation start
  await supabase.from('operation_logs').insert({
    operation_type: 'fee_claim',
    status: 'started',
    details: { scope: 'all_pools' },
  });

  const pools = await getActivePools();
  const result: CollectionResult = {
    totalPoolsProcessed: pools.length,
    successfulClaims: 0,
    failedClaims: 0,
    totalQuoteCollected: 0,
    claims: [],
  };

  log.info({ poolCount: pools.length }, 'Found active pools');

  for (const pool of pools) {
    const claimResult = await claimFeesFromPool(pool);
    result.claims.push(claimResult);

    if (claimResult.success) {
      result.successfulClaims++;
      result.totalQuoteCollected += claimResult.quoteAmount;
    } else {
      result.failedClaims++;
    }

    // Small delay between claims to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  log.info(
    {
      totalPools: result.totalPoolsProcessed,
      successful: result.successfulClaims,
      failed: result.failedClaims,
      totalCollected: result.totalQuoteCollected,
    },
    'Fee collection completed'
  );

  return result;
}
