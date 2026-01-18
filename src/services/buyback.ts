import { VersionedTransaction } from '@solana/web3.js';
import { getSupabaseUntyped, type BuybackInsert, type FlywheelPool } from '../db/index.js';
import { getFlywheelWallet, getWalletBalance } from '../solana/index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getBuybackAllocations } from './marketcap.js';

const log = logger.child({ module: 'buyback' });

// Wrapped SOL mint
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// Jupiter Ultra API Order Response
export interface JupiterUltraOrder {
  mode: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  priceImpact?: number;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
    };
    percent: number;
    bps?: number;
    usdValue?: number;
  }>;
  feeBps: number;
  platformFee: {
    feeBps: number;
    amount: string;
  };
  signatureFeeLamports: number;
  prioritizationFeeLamports: number;
  rentFeeLamports: number;
  router: 'iris' | 'jupiterz' | 'dflow' | 'okx';
  transaction: string | null;
  gasless: boolean;
  requestId: string;
  totalTime: number;
  taker: string | null;
  inUsdValue?: number;
  outUsdValue?: number;
  errorCode?: number;
  errorMessage?: string;
}

export interface BuybackResult {
  success: boolean;
  solAmount: number;
  tokenAmount: number;
  txSignature: string;
  pricePerToken: number;
  error?: string;
}

// Multi-token buyback result
export interface MultiBuybackResult {
  success: boolean;
  totalSolUsed: number;
  poolsProcessed: number;
  poolsSuccessful: number;
  poolsFailed: number;
  results: Array<{
    pool: FlywheelPool;
    solAllocated: number;
    tokensBought: number;
    txSignature: string;
    success: boolean;
    error?: string;
  }>;
}

/**
 * Get an order from Jupiter Ultra API for swapping SOL to a token
 * Returns unsigned transaction ready to sign
 */
export async function getJupiterUltraOrder(
  solAmount: number,
  outputMint: string,
  taker: string
): Promise<JupiterUltraOrder> {
  const inputMint = WSOL_MINT;
  const amount = Math.floor(solAmount * 1e9); // Convert to lamports

  const url = new URL(`${config.jupiter.apiUrl}/order`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amount.toString());
  url.searchParams.set('taker', taker);

  log.debug({ url: url.toString(), outputMint }, 'Fetching Jupiter Ultra order');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'x-api-key': config.jupiter.apiKey,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Jupiter Ultra order failed: ${error}`);
  }

  const order = (await response.json()) as JupiterUltraOrder;

  // Check for errors in response
  if (order.errorCode || order.errorMessage) {
    throw new Error(`Jupiter Ultra order error: ${order.errorMessage || `Code ${order.errorCode}`}`);
  }

  if (!order.transaction) {
    throw new Error('Jupiter Ultra order returned no transaction');
  }

  log.info(
    {
      inAmount: order.inAmount,
      outAmount: order.outAmount,
      priceImpact: order.priceImpact,
      router: order.router,
      requestId: order.requestId,
    },
    'Jupiter Ultra order received'
  );

  return order;
}

// Jupiter Ultra Execute Response
export interface JupiterUltraExecuteResponse {
  status: 'Success' | 'Failed';
  code: number;
  signature?: string;
  slot?: string;
  error?: string;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  swapEvents?: Array<{
    inputMint: string;
    inputAmount: string;
    outputMint: string;
    outputAmount: string;
  }>;
}

/**
 * Execute a signed transaction via Jupiter Ultra API
 * This ensures proper transaction landing with Jupiter's infrastructure
 */
export async function executeJupiterUltra(
  signedTransaction: string,
  requestId: string
): Promise<JupiterUltraExecuteResponse> {
  const response = await fetch(`${config.jupiter.apiUrl}/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.jupiter.apiKey,
    },
    body: JSON.stringify({
      signedTransaction,
      requestId,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Jupiter Ultra execute failed: ${error}`);
  }

  const result = (await response.json()) as JupiterUltraExecuteResponse;

  if (result.status === 'Failed') {
    throw new Error(`Jupiter swap failed: ${result.error || 'Unknown error'}`);
  }

  log.info(
    {
      signature: result.signature,
      inputAmount: result.inputAmountResult,
      outputAmount: result.outputAmountResult,
    },
    'Jupiter Ultra execute successful'
  );

  return result;
}

/**
 * Execute a buyback - swap SOL for native token
 */
export async function executeBuyback(solAmount?: number): Promise<BuybackResult> {
  const wallet = getFlywheelWallet();
  const supabase = getSupabaseUntyped();

  const result: BuybackResult = {
    success: false,
    solAmount: 0,
    tokenAmount: 0,
    txSignature: '',
    pricePerToken: 0,
  };

  try {
    // Determine amount to swap
    const walletBalance = await getWalletBalance();
    const minBuyback = config.thresholds.minBuybackSol;

    // Reserve SOL for transaction fees (configurable)
    const availableBalance = walletBalance - config.thresholds.reserveSol;

    if (solAmount) {
      result.solAmount = Math.min(solAmount, availableBalance);
    } else {
      result.solAmount = availableBalance;
    }

    // Check minimum threshold
    if (result.solAmount < minBuyback) {
      log.info(
        { balance: walletBalance, minThreshold: minBuyback },
        'Insufficient balance for buyback'
      );
      result.error = `Insufficient balance: ${result.solAmount} SOL < ${minBuyback} SOL minimum`;
      return result;
    }

    log.info({ solAmount: result.solAmount }, 'Initiating buyback');

    // Log operation start
    await supabase.from('operation_logs').insert({
      operation_type: 'buyback',
      status: 'started',
      details: { sol_amount: result.solAmount },
    });

    // Get Jupiter Ultra order (includes unsigned transaction)
    const order = await getJupiterUltraOrder(
      result.solAmount,
      config.token.nativeMint,
      wallet.publicKey.toString()
    );

    // Deserialize and sign transaction
    const swapTransactionBuf = Buffer.from(order.transaction!, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);

    // Serialize signed transaction back to base64
    const signedTransaction = Buffer.from(transaction.serialize()).toString('base64');

    // Execute via Jupiter Ultra API (handles landing)
    const executeResult = await executeJupiterUltra(signedTransaction, order.requestId);

    const txSignature = executeResult.signature!;

    // Calculate results
    const tokenAmount = Number(executeResult.outputAmountResult || order.outAmount) / 1e9;
    const pricePerToken = result.solAmount / tokenAmount;

    result.tokenAmount = tokenAmount;
    result.txSignature = txSignature;
    result.pricePerToken = pricePerToken;
    result.success = true;

    // Record in database
    const buybackData: BuybackInsert = {
      sol_amount: result.solAmount,
      native_token_amount: tokenAmount,
      native_token_mint: config.token.nativeMint,
      tx_signature: txSignature,
      price_per_token: pricePerToken,
      slippage_bps: config.thresholds.slippageBps,
    };

    const { data: buybackRecord } = await supabase
      .from('buybacks')
      .insert(buybackData)
      .select()
      .single();

    // Log operation completion
    await supabase.from('operation_logs').insert({
      operation_type: 'buyback',
      status: 'completed',
      tx_signature: txSignature,
      details: {
        sol_amount: result.solAmount,
        token_amount: tokenAmount,
        price_per_token: pricePerToken,
        buyback_id: buybackRecord?.id,
      },
    });

    log.info(
      {
        solAmount: result.solAmount,
        tokenAmount,
        txSignature,
        pricePerToken,
      },
      'Buyback executed successfully'
    );

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    result.error = errorMessage;

    log.error({ error }, 'Buyback failed');

    // Log failed operation
    await supabase.from('operation_logs').insert({
      operation_type: 'buyback',
      status: 'failed',
      error_message: errorMessage,
      details: { sol_amount: result.solAmount },
    });

    return result;
  }
}

/**
 * Check if buyback is needed based on accumulated balance
 */
export async function shouldExecuteBuyback(): Promise<{
  shouldBuyback: boolean;
  balance: number;
  threshold: number;
}> {
  const balance = await getWalletBalance();
  const threshold = config.thresholds.minBuybackSol;

  // Reserve for fees (configurable)
  const availableBalance = balance - config.thresholds.reserveSol;

  return {
    shouldBuyback: availableBalance >= threshold,
    balance: availableBalance,
    threshold,
  };
}

/**
 * Execute buyback for a specific token (pool)
 */
export async function executeBuybackForPool(
  pool: FlywheelPool,
  solAmount: number
): Promise<BuybackResult> {
  const wallet = getFlywheelWallet();
  const supabase = getSupabaseUntyped();

  const result: BuybackResult = {
    success: false,
    solAmount,
    tokenAmount: 0,
    txSignature: '',
    pricePerToken: 0,
  };

  try {
    // Minimum viable buyback (0.001 SOL)
    if (solAmount < 0.001) {
      log.debug({ poolAddress: pool.pool_address, solAmount }, 'Amount too small for buyback');
      result.error = 'Amount too small';
      return result;
    }

    log.info({ poolAddress: pool.pool_address, baseMint: pool.base_mint, solAmount }, 'Initiating token buyback');

    // Get Jupiter Ultra order for this specific token
    const order = await getJupiterUltraOrder(
      solAmount,
      pool.base_mint,
      wallet.publicKey.toString()
    );

    // Deserialize and sign transaction
    const swapTransactionBuf = Buffer.from(order.transaction!, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);

    // Serialize signed transaction back to base64
    const signedTransaction = Buffer.from(transaction.serialize()).toString('base64');

    // Execute via Jupiter Ultra API (handles landing)
    const executeResult = await executeJupiterUltra(signedTransaction, order.requestId);

    const txSignature = executeResult.signature!;

    // Get token decimals for proper conversion
    const tokenDecimals = 9; // Default, could fetch from chain
    const tokenAmount = Number(executeResult.outputAmountResult || order.outAmount) / Math.pow(10, tokenDecimals);
    const pricePerToken = solAmount / tokenAmount;

    result.tokenAmount = tokenAmount;
    result.txSignature = txSignature;
    result.pricePerToken = pricePerToken;
    result.success = true;

    // Record in database with pool reference
    const buybackData: BuybackInsert = {
      pool_id: pool.id,
      token_mint: pool.base_mint,
      sol_amount: solAmount,
      native_token_amount: tokenAmount,
      native_token_mint: pool.base_mint,
      tx_signature: txSignature,
      price_per_token: pricePerToken,
      slippage_bps: config.thresholds.slippageBps,
    };

    await supabase.from('buybacks').insert(buybackData);

    // Update pool stats
    await supabase
      .from('flywheel_pools')
      .update({
        total_tokens_bought: pool.total_tokens_bought + tokenAmount,
        last_buyback_at: new Date().toISOString(),
      })
      .eq('id', pool.id);

    log.info(
      { poolAddress: pool.pool_address, solAmount, tokenAmount, txSignature },
      'Token buyback successful'
    );

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    result.error = errorMessage;
    log.error({ error, poolAddress: pool.pool_address }, 'Token buyback failed');
    return result;
  }
}

/**
 * Execute proportional multi-token buyback across all platform tokens
 * Allocation is based on marketcap - higher marketcap = larger allocation
 */
export async function executeMultiBuyback(totalSolAmount?: number): Promise<MultiBuybackResult> {
  const supabase = getSupabaseUntyped();

  const result: MultiBuybackResult = {
    success: false,
    totalSolUsed: 0,
    poolsProcessed: 0,
    poolsSuccessful: 0,
    poolsFailed: 0,
    results: [],
  };

  try {
    // Determine total amount to spend
    const walletBalance = await getWalletBalance();
    const reserveForFees = config.thresholds.reserveSol; // Configurable reserve
    const availableBalance = walletBalance - reserveForFees;
    
    // Apply buyback percentage (default 80%)
    const percentageMultiplier = config.thresholds.buybackPercentage / 100;
    const maxBuybackAmount = availableBalance * percentageMultiplier;

    const solToSpend = totalSolAmount
      ? Math.min(totalSolAmount, maxBuybackAmount)
      : maxBuybackAmount;

    if (solToSpend < config.thresholds.minBuybackSol) {
      log.info({ balance: walletBalance, required: config.thresholds.minBuybackSol }, 'Insufficient balance for multi-buyback');
      result.success = false;
      return result;
    }

    log.info({ solToSpend }, 'Starting multi-token buyback');

    // Log operation start
    await supabase.from('operation_logs').insert({
      operation_type: 'buyback',
      status: 'started',
      details: { scope: 'multi_token', total_sol: solToSpend },
    });

    // Get proportional allocations based on marketcap
    const allocations = await getBuybackAllocations();

    if (allocations.length === 0) {
      log.warn('No pools available for buyback');
      return result;
    }

    // Calculate SOL allocation for each pool
    for (const allocation of allocations) {
      allocation.allocatedSol = (solToSpend * allocation.allocationPercent) / 100;
    }

    log.info(
      { poolCount: allocations.length, totalSol: solToSpend },
      'Calculated buyback allocations'
    );

    // Execute buyback for each pool
    for (const allocation of allocations) {
      result.poolsProcessed++;

      // Skip if allocation is too small
      if (allocation.allocatedSol < 0.001) {
        log.debug(
          { poolAddress: allocation.pool.pool_address, allocated: allocation.allocatedSol },
          'Skipping pool with minimal allocation'
        );
        continue;
      }

      const buybackResult = await executeBuybackForPool(
        allocation.pool,
        allocation.allocatedSol
      );

      result.results.push({
        pool: allocation.pool,
        solAllocated: allocation.allocatedSol,
        tokensBought: buybackResult.tokenAmount,
        txSignature: buybackResult.txSignature,
        success: buybackResult.success,
        error: buybackResult.error,
      });

      if (buybackResult.success) {
        result.poolsSuccessful++;
        result.totalSolUsed += allocation.allocatedSol;
      } else {
        result.poolsFailed++;
      }

      // Rate limiting between swaps
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    result.success = result.poolsSuccessful > 0;

    // Log operation completion
    await supabase.from('operation_logs').insert({
      operation_type: 'buyback',
      status: result.success ? 'completed' : 'failed',
      details: {
        scope: 'multi_token',
        total_sol_used: result.totalSolUsed,
        pools_successful: result.poolsSuccessful,
        pools_failed: result.poolsFailed,
      },
    });

    // Update global stats
    await supabase
      .from('flywheel_stats')
      .update({
        total_sol_used_for_buyback: result.totalSolUsed,
        last_buyback_at: new Date().toISOString(),
      })
      .eq('id', 1);

    log.info(
      {
        totalSolUsed: result.totalSolUsed,
        successful: result.poolsSuccessful,
        failed: result.poolsFailed,
      },
      'Multi-token buyback completed'
    );

    return result;
  } catch (error) {
    log.error({ error }, 'Multi-token buyback failed');

    await supabase.from('operation_logs').insert({
      operation_type: 'buyback',
      status: 'failed',
      error_message: error instanceof Error ? error.message : String(error),
    });

    return result;
  }
}
