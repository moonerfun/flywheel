import { PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { CpAmm, getUnClaimLpFee, getTokenProgram } from '@meteora-ag/cp-amm-sdk';
import { getSupabaseUntyped, type FeeClaimInsert, type FlywheelPool } from '../db/index.js';
import { getConnection, getFlywheelWallet } from '../solana/index.js';
import { getMigratedPools } from './registry.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ module: 'collector-dammv2' });

export interface DammV2FeeClaimResult {
  poolAddress: string;
  dammPoolAddress: string;
  positionAddress: string;
  tokenAAmount: number;
  tokenBAmount: number; // This is SOL for migrated pools
  txSignature: string;
  success: boolean;
  error?: string;
}

export interface DammV2CollectionResult {
  totalPoolsProcessed: number;
  successfulClaims: number;
  failedClaims: number;
  totalSolCollected: number;
  totalTokensCollected: number;
  claims: DammV2FeeClaimResult[];
}

/**
 * Get claimable fees from a DAMM v2 position
 */
export async function getDammV2ClaimableFees(
  dammPoolAddress: string,
  ownerWallet: PublicKey
): Promise<{
  positionAddress: string | null;
  tokenAAmount: number;
  tokenBAmount: number;
  hasPosition: boolean;
}> {
  const connection = getConnection();

  try {
    const cpAmm = new CpAmm(connection);
    const poolPubkey = new PublicKey(dammPoolAddress);

    // Get pool state
    const poolState = await cpAmm.fetchPoolState(poolPubkey);
    if (!poolState) {
      return { positionAddress: null, tokenAAmount: 0, tokenBAmount: 0, hasPosition: false };
    }

    // Get user positions in this pool
    const userPositions = await cpAmm.getUserPositionByPool(poolPubkey, ownerWallet);

    if (userPositions.length === 0) {
      return { positionAddress: null, tokenAAmount: 0, tokenBAmount: 0, hasPosition: false };
    }

    // Sum up all unclaimed fees from all positions
    let totalTokenA = 0;
    let totalTokenB = 0;
    let firstPositionAddress: string | null = null;

    for (const userPosition of userPositions) {
      const positionState = await cpAmm.fetchPositionState(userPosition.position);
      const unclaimedFees = getUnClaimLpFee(poolState, positionState);

      totalTokenA += Number(unclaimedFees.feeTokenA) / 1e6; // Assuming 6 decimals for tokens
      totalTokenB += Number(unclaimedFees.feeTokenB) / 1e9; // SOL has 9 decimals

      if (!firstPositionAddress) {
        firstPositionAddress = userPosition.position.toString();
      }
    }

    return {
      positionAddress: firstPositionAddress,
      tokenAAmount: totalTokenA,
      tokenBAmount: totalTokenB,
      hasPosition: true,
    };
  } catch (error) {
    log.error({ error, dammPoolAddress }, 'Failed to get DAMM v2 claimable fees');
    return { positionAddress: null, tokenAAmount: 0, tokenBAmount: 0, hasPosition: false };
  }
}

/**
 * Claim fees from a single DAMM v2 pool position
 */
export async function claimDammV2Fees(
  pool: FlywheelPool,
  dammPoolAddress: string
): Promise<DammV2FeeClaimResult> {
  const connection = getConnection();
  const wallet = getFlywheelWallet();
  const supabase = getSupabaseUntyped();

  const result: DammV2FeeClaimResult = {
    poolAddress: pool.pool_address,
    dammPoolAddress,
    positionAddress: '',
    tokenAAmount: 0,
    tokenBAmount: 0,
    txSignature: '',
    success: false,
  };

  try {
    log.info({ poolAddress: pool.pool_address, dammPoolAddress }, 'Claiming DAMM v2 fees');

    const cpAmm = new CpAmm(connection);
    const poolPubkey = new PublicKey(dammPoolAddress);

    // Get pool state
    const poolState = await cpAmm.fetchPoolState(poolPubkey);
    if (!poolState) {
      throw new Error('DAMM v2 pool not found');
    }

    // Get user positions
    const userPositions = await cpAmm.getUserPositionByPool(poolPubkey, wallet.publicKey);

    if (userPositions.length === 0) {
      log.info({ dammPoolAddress }, 'No DAMM v2 positions found');
      result.success = true;
      return result;
    }

    // Claim fees from each position
    for (const userPosition of userPositions) {
      const positionState = await cpAmm.fetchPositionState(userPosition.position);
      const unclaimedFees = getUnClaimLpFee(poolState, positionState);

      // Skip if no fees to claim
      if (unclaimedFees.feeTokenA.isZero() && unclaimedFees.feeTokenB.isZero()) {
        continue;
      }

      result.positionAddress = userPosition.position.toString();
      result.tokenAAmount += Number(unclaimedFees.feeTokenA) / 1e6;
      result.tokenBAmount += Number(unclaimedFees.feeTokenB) / 1e9;

      // Build claim transaction (without receiver/feePayer - SDK sets defaults)
      const claimTx = await cpAmm.claimPositionFee({
        owner: wallet.publicKey,
        pool: poolPubkey,
        position: userPosition.position,
        positionNftAccount: userPosition.positionNftAccount,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        tokenAProgram: getTokenProgram(poolState.tokenAFlag),
        tokenBProgram: getTokenProgram(poolState.tokenBFlag),
      });

      // Send transaction
      const txSignature = await sendAndConfirmTransaction(connection, claimTx, [wallet], {
        commitment: 'confirmed',
      });

      result.txSignature = txSignature;
      result.success = true;

      log.info(
        {
          dammPoolAddress,
          positionAddress: userPosition.position.toString(),
          tokenAAmount: result.tokenAAmount,
          tokenBAmount: result.tokenBAmount,
          txSignature,
        },
        'DAMM v2 fees claimed successfully'
      );
    }

    // Record in database
    if (result.tokenBAmount > 0 || result.tokenAAmount > 0) {
      const feeClaimData: FeeClaimInsert = {
        pool_id: pool.id,
        pool_address: pool.pool_address,
        quote_amount: result.tokenBAmount, // SOL
        base_amount: result.tokenAAmount, // Token
        tx_signature: result.txSignature,
        fee_type: 'damm_v2_lp',
      };

      await supabase.from('fee_claims').insert(feeClaimData);

      // Log operation
      await supabase.from('operation_logs').insert({
        operation_type: 'fee_claim_damm_v2',
        status: 'completed',
        tx_signature: result.txSignature,
        details: {
          pool_address: pool.pool_address,
          damm_pool_address: dammPoolAddress,
          token_a_amount: result.tokenAAmount,
          token_b_amount: result.tokenBAmount,
        },
      });
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    result.error = errorMessage;

    log.error({ error, poolAddress: pool.pool_address, dammPoolAddress }, 'Failed to claim DAMM v2 fees');

    // Log failed operation
    await supabase.from('operation_logs').insert({
      operation_type: 'fee_claim_damm_v2',
      status: 'failed',
      error_message: errorMessage,
      details: {
        pool_address: pool.pool_address,
        damm_pool_address: dammPoolAddress,
      },
    });

    return result;
  }
}

/**
 * Collect fees from all migrated DAMM v2 pools
 */
export async function collectAllDammV2Fees(): Promise<DammV2CollectionResult> {
  const wallet = getFlywheelWallet();

  log.info('Starting DAMM v2 fee collection from migrated pools');

  // Get all migrated pools that have DAMM v2 addresses
  const migratedPools = await getMigratedPools();

  log.info({ poolCount: migratedPools.length }, 'Found migrated DAMM v2 pools');

  const result: DammV2CollectionResult = {
    totalPoolsProcessed: migratedPools.length,
    successfulClaims: 0,
    failedClaims: 0,
    totalSolCollected: 0,
    totalTokensCollected: 0,
    claims: [],
  };

  if (migratedPools.length === 0) {
    log.info('No migrated DAMM v2 pools to collect from');
    return result;
  }

  // Process each migrated pool
  for (const pool of migratedPools) {
    if (!pool.damm_pool_address) continue;

    try {
      // Check if we have a position and claimable fees
      const claimable = await getDammV2ClaimableFees(pool.damm_pool_address, wallet.publicKey);

      if (!claimable.hasPosition) {
        log.debug({ poolAddress: pool.pool_address }, 'No DAMM v2 position found');
        continue;
      }

      if (claimable.tokenBAmount <= 0 && claimable.tokenAAmount <= 0) {
        log.debug({ poolAddress: pool.pool_address }, 'No DAMM v2 fees to claim');
        result.successfulClaims++;
        continue;
      }

      // Claim fees
      const claimResult = await claimDammV2Fees(pool, pool.damm_pool_address);
      result.claims.push(claimResult);

      if (claimResult.success) {
        result.successfulClaims++;
        result.totalSolCollected += claimResult.tokenBAmount;
        result.totalTokensCollected += claimResult.tokenAAmount;
      } else {
        result.failedClaims++;
      }

      // Small delay between claims to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      log.error({ error, poolAddress: pool.pool_address }, 'Error processing DAMM v2 pool');
      result.failedClaims++;
    }
  }

  log.info(
    {
      totalPools: result.totalPoolsProcessed,
      successful: result.successfulClaims,
      failed: result.failedClaims,
      totalSol: result.totalSolCollected,
      totalTokens: result.totalTokensCollected,
    },
    'DAMM v2 fee collection completed'
  );

  return result;
}
