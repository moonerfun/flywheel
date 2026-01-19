import { PublicKey, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import {
  createBurnInstruction,
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { getSupabaseUntyped, type BurnInsert, type FlywheelPool } from '../db/index.js';
import { getConnection, getFlywheelWallet } from '../solana/index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getAllCollectablePools, getMigratedPools } from './registry.js';

const log = logger.child({ module: 'burner' });

export interface BurnResult {
  success: boolean;
  amount: number;
  txSignature: string;
  error?: string;
}

// Multi-token burn result
export interface MultiBurnResult {
  success: boolean;
  totalBurned: number;
  poolsProcessed: number;
  poolsSuccessful: number;
  poolsFailed: number;
  results: Array<{
    pool: FlywheelPool;
    amount: number;
    txSignature: string;
    success: boolean;
    error?: string;
  }>;
}

/**
 * Get the token balance of the flywheel wallet for a specific token
 */
export async function getTokenBalance(tokenMint: string): Promise<number> {
  const connection = getConnection();
  const wallet = getFlywheelWallet();
  const mint = new PublicKey(tokenMint);

  try {
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
    const account = await getAccount(connection, ata);
    // Get token decimals for proper conversion
    const mintInfo = await connection.getParsedAccountInfo(mint);
    const decimals = (mintInfo.value?.data as { parsed: { info: { decimals: number } } })?.parsed?.info?.decimals || 9;
    return Number(account.amount) / Math.pow(10, decimals);
  } catch (error) {
    // Account doesn't exist or has no balance
    return 0;
  }
}

/**
 * Get the token balance for the native/platform token (backwards compatibility)
 */
export async function getNativeTokenBalance(): Promise<number> {
  // For multi-token, we return total across all tokens or a specific platform token
  if (config.token?.nativeMint) {
    return getTokenBalance(config.token.nativeMint);
  }

  // Sum all token balances
  const pools = await getAllCollectablePools();
  let total = 0;
  for (const pool of pools) {
    total += await getTokenBalance(pool.base_mint);
  }
  return total;
}

/**
 * Burn tokens for a specific pool/token
 */
export async function burnTokensForPool(
  pool: FlywheelPool,
  amount?: number,
  buybackId?: string
): Promise<BurnResult> {
  const connection = getConnection();
  const wallet = getFlywheelWallet();
  const supabase = getSupabaseUntyped();
  const tokenMint = new PublicKey(pool.base_mint);

  const result: BurnResult = {
    success: false,
    amount: 0,
    txSignature: '',
  };

  try {
    // Get current balance for this token
    const balance = await getTokenBalance(pool.base_mint);

    if (balance <= 0) {
      log.debug({ poolAddress: pool.pool_address }, 'No tokens to burn for this pool');
      result.error = 'No tokens to burn';
      return result;
    }

    // Determine amount to burn
    const burnAmount = amount ? Math.min(amount, balance) : balance;
    result.amount = burnAmount;

    log.info({ poolAddress: pool.pool_address, baseMint: pool.base_mint, burnAmount, balance }, 'Initiating token burn');

    // Get token account
    const ata = await getAssociatedTokenAddress(tokenMint, wallet.publicKey);

    // Get decimals for proper conversion
    const mintInfo = await connection.getParsedAccountInfo(tokenMint);
    const decimals = (mintInfo.value?.data as { parsed: { info: { decimals: number } } })?.parsed?.info?.decimals || 9;
    const burnLamports = BigInt(Math.floor(burnAmount * Math.pow(10, decimals)));

    // Create burn instruction
    const burnIx = createBurnInstruction(
      ata,
      tokenMint,
      wallet.publicKey,
      burnLamports,
      [],
      TOKEN_PROGRAM_ID
    );

    // Build transaction
    const transaction = new Transaction().add(burnIx);
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;

    // Send and confirm
    const txSignature = await sendAndConfirmTransaction(connection, transaction, [wallet], {
      commitment: 'confirmed',
    });

    result.txSignature = txSignature;
    result.success = true;

    // Record in database with pool reference
    const burnData: BurnInsert = {
      buyback_id: buybackId || null,
      pool_id: pool.id,
      amount: burnAmount,
      native_token_mint: pool.base_mint,
      tx_signature: txSignature,
    };

    await supabase.from('burns').insert(burnData);

    // Update pool stats
    await supabase
      .from('flywheel_pools')
      .update({
        total_tokens_burned: pool.total_tokens_burned + burnAmount,
        last_burn_at: new Date().toISOString(),
      })
      .eq('id', pool.id);

    log.info(
      { poolAddress: pool.pool_address, amount: burnAmount, txSignature },
      'Tokens burned successfully for pool'
    );

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    result.error = errorMessage;
    log.error({ error, poolAddress: pool.pool_address }, 'Token burn failed for pool');
    return result;
  }
}

/**
 * Burn all tokens across migrated pools only
 * NOTE: Only migrated tokens participate in burn - non-migrated tokens do not benefit from the flywheel effect
 */
export async function burnAllTokens(): Promise<MultiBurnResult> {
  const supabase = getSupabaseUntyped();

  const result: MultiBurnResult = {
    success: false,
    totalBurned: 0,
    poolsProcessed: 0,
    poolsSuccessful: 0,
    poolsFailed: 0,
    results: [],
  };

  try {
    log.info('Starting multi-token burn (migrated pools only)');

    // Log operation start
    await supabase.from('operation_logs').insert({
      operation_type: 'burn',
      status: 'started',
      details: { scope: 'multi_token' },
    });

    // Only burn tokens for migrated pools - non-migrated tokens don't benefit from flywheel
    const pools = await getMigratedPools();

    log.info({ migratedPoolCount: pools.length }, 'Burning tokens for migrated pools only');

    // Build list of excluded mints
    const excludedMints = new Set(config.burn?.excludeMints || []);
    // Also exclude native token if configured
    if (config.burn?.excludeNativeToken && config.token?.nativeMint) {
      excludedMints.add(config.token.nativeMint);
    }

    if (excludedMints.size > 0) {
      log.info({ excludedMints: Array.from(excludedMints) }, 'Excluding mints from burn');
    }

    for (const pool of pools) {
      result.poolsProcessed++;

      // Skip excluded mints
      if (excludedMints.has(pool.base_mint)) {
        log.info({ poolAddress: pool.pool_address, baseMint: pool.base_mint }, 'Skipping excluded token from burn');
        continue;
      }

      // Check if we have any tokens for this pool
      const balance = await getTokenBalance(pool.base_mint);
      if (balance <= 0) {
        log.debug({ poolAddress: pool.pool_address }, 'No tokens to burn, skipping');
        continue;
      }

      const burnResult = await burnTokensForPool(pool);

      result.results.push({
        pool,
        amount: burnResult.amount,
        txSignature: burnResult.txSignature,
        success: burnResult.success,
        error: burnResult.error,
      });

      if (burnResult.success) {
        result.poolsSuccessful++;
        result.totalBurned += burnResult.amount;
      } else {
        result.poolsFailed++;
      }

      // Rate limiting between burns
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    result.success = result.poolsSuccessful > 0;

    // Log operation completion
    await supabase.from('operation_logs').insert({
      operation_type: 'burn',
      status: result.success ? 'completed' : 'failed',
      details: {
        scope: 'multi_token',
        total_burned: result.totalBurned,
        pools_successful: result.poolsSuccessful,
        pools_failed: result.poolsFailed,
      },
    });

    // Update global stats
    await supabase
      .from('flywheel_stats')
      .update({
        last_burn_at: new Date().toISOString(),
      })
      .eq('id', 1);

    log.info(
      {
        totalBurned: result.totalBurned,
        successful: result.poolsSuccessful,
        failed: result.poolsFailed,
      },
      'Multi-token burn completed'
    );

    return result;
  } catch (error) {
    log.error({ error }, 'Multi-token burn failed');

    await supabase.from('operation_logs').insert({
      operation_type: 'burn',
      status: 'failed',
      error_message: error instanceof Error ? error.message : String(error),
    });

    return result;
  }
}

/**
 * Burn native tokens from the flywheel wallet (backwards compatibility)
 */
export async function burnTokens(amount?: number, buybackId?: string): Promise<BurnResult> {
  // For backwards compatibility - burns platform token if configured
  if (config.token?.nativeMint) {
    const pool: FlywheelPool = {
      id: '',
      pool_address: '',
      base_mint: config.token.nativeMint,
      quote_mint: '',
      config_key: '',
      creator: '',
      name: null,
      symbol: null,
      is_migrated: false,
      damm_pool_address: null,
      status: 'active',
      current_marketcap_usd: 0,
      current_price_usd: 0,
      total_supply: 0,
      circulating_supply: 0,
      marketcap_rank: 0,
      marketcap_updated_at: null,
      total_fees_collected_sol: 0,
      total_tokens_bought: 0,
      total_tokens_burned: 0,
      last_buyback_at: null,
      last_burn_at: null,
      discovery_source: 'manual',
      created_at: '',
      updated_at: '',
    };
    return burnTokensForPool(pool, amount, buybackId);
  }

  // Otherwise, burn all tokens
  const multiResult = await burnAllTokens();
  return {
    success: multiResult.success,
    amount: multiResult.totalBurned,
    txSignature: multiResult.results[0]?.txSignature || '',
    error: multiResult.success ? undefined : 'Multi-burn failed',
  };
}

/**
 * Get total tokens burned from database
 */
export async function getTotalBurned(): Promise<number> {
  const supabase = getSupabaseUntyped();

  const { data } = await supabase.from('flywheel_stats').select('total_tokens_burned').single();

  return (data as { total_tokens_burned: number } | null)?.total_tokens_burned || 0;
}

/**
 * Get total burned for a specific pool
 */
export async function getTotalBurnedForPool(poolId: string): Promise<number> {
  const supabase = getSupabaseUntyped();

  const { data } = await supabase
    .from('flywheel_pools')
    .select('total_tokens_burned')
    .eq('id', poolId)
    .single();

  return (data as { total_tokens_burned: number } | null)?.total_tokens_burned || 0;
}
