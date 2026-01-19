import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getSupabaseUntyped } from '../db/index.js';
import { getWalletBalance, getFlywheelWallet } from '../solana/index.js';
import {
  getActivePools,
  getPoolSummary,
  registerPool,
  type RegisterPoolParams,
} from '../services/registry.js';
import { collectAllFees, getClaimableFees } from '../services/collector.js';
import { executeBuyback, executeMultiBuyback, shouldExecuteBuyback } from '../services/buyback.js';
import { burnTokens, burnAllTokens, getNativeTokenBalance, getTotalBurned } from '../services/burner.js';
import { updateAllMarketcaps, getBuybackAllocations } from '../services/marketcap.js';
import { discoverPlatformPools } from '../services/discovery.js';
import { getSchedulerStatus, triggerTask } from '../scheduler/index.js';

const log = logger.child({ module: 'api' });

export const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  log.debug({ method: req.method, path: req.path }, 'Request');
  next();
});

// ============================================
// Health & Status Endpoints
// ============================================

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/status', async (_req: Request, res: Response) => {
  try {
    const wallet = getFlywheelWallet();
    const walletBalance = await getWalletBalance();
    const tokenBalance = await getNativeTokenBalance();
    const schedulerStatus = getSchedulerStatus();

    res.json({
      status: 'running',
      wallet: wallet.publicKey.toString(),
      balances: {
        sol: walletBalance,
        nativeToken: tokenBalance,
      },
      scheduler: schedulerStatus,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.error({ error }, 'Status check failed');
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// ============================================
// Stats Endpoints
// ============================================

app.get('/stats', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabaseUntyped();
    const { data, error } = await supabase.from('flywheel_stats').select('*').single();

    if (error) {
      throw error;
    }

    const walletBalance = await getWalletBalance();
    const tokenBalance = await getNativeTokenBalance();

    const statsData = data as Record<string, unknown> | null;
    res.json({
      ...(statsData || {}),
      current_balances: {
        sol: walletBalance,
        native_token: tokenBalance,
      },
    });
  } catch (error) {
    log.error({ error }, 'Failed to get stats');
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.get('/stats/recent', async (_req: Request, res: Response) => {
  try {
    const supabase = getSupabaseUntyped();
    const { data, error } = await supabase
      .from('recent_operations')
      .select('*')
      .limit(50);

    if (error) {
      throw error;
    }

    res.json(data);
  } catch (error) {
    log.error({ error }, 'Failed to get recent operations');
    res.status(500).json({ error: 'Failed to get recent operations' });
  }
});

// ============================================
// Pool Endpoints
// ============================================

app.get('/pools', async (_req: Request, res: Response) => {
  try {
    const pools = await getActivePools();
    res.json(pools);
  } catch (error) {
    log.error({ error }, 'Failed to get pools');
    res.status(500).json({ error: 'Failed to get pools' });
  }
});

app.get('/pools/summary', async (_req: Request, res: Response) => {
  try {
    const summary = await getPoolSummary();
    res.json(summary);
  } catch (error) {
    log.error({ error }, 'Failed to get pool summary');
    res.status(500).json({ error: 'Failed to get pool summary' });
  }
});

app.get('/pools/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address;
    if (!address) {
      res.status(400).json({ error: 'Pool address required' });
      return;
    }

    const supabase = getSupabaseUntyped();
    const { data, error } = await supabase
      .from('flywheel_pools')
      .select('*')
      .eq('pool_address', address)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Pool not found' });
      return;
    }

    // Get claimable fees
    const claimable = await getClaimableFees(address);

    const poolData = data as Record<string, unknown>;
    res.json({
      ...poolData,
      claimable_fees: claimable,
    });
  } catch (error) {
    log.error({ error }, 'Failed to get pool');
    res.status(500).json({ error: 'Failed to get pool' });
  }
});

app.post('/pools/register', async (req: Request, res: Response) => {
  try {
    const params: RegisterPoolParams = req.body;

    if (!params.poolAddress || !params.baseMint || !params.quoteMint || !params.configKey || !params.creator) {
      res.status(400).json({
        error: 'Missing required fields: poolAddress, baseMint, quoteMint, configKey, creator',
      });
      return;
    }

    const pool = await registerPool(params);
    res.status(201).json(pool);
  } catch (error) {
    log.error({ error }, 'Failed to register pool');
    res.status(500).json({ error: 'Failed to register pool' });
  }
});

// ============================================
// Webhook Endpoints (for moonerfun integration)
// ============================================

app.post('/webhook/pool-created', async (req: Request, res: Response) => {
  try {
    const { poolAddress, baseMint, quoteMint, configKey, creator, name, symbol } = req.body;

    if (!poolAddress) {
      res.status(400).json({ error: 'Missing poolAddress' });
      return;
    }

    log.info({ poolAddress, name, symbol }, 'Pool creation webhook received');

    const pool = await registerPool({
      poolAddress,
      baseMint: baseMint || '',
      quoteMint: quoteMint || 'So11111111111111111111111111111111111111112',
      configKey: configKey || config.token.poolConfigKey,
      creator: creator || '',
      name,
      symbol,
    });

    res.status(201).json({ success: true, pool });
  } catch (error) {
    log.error({ error }, 'Pool creation webhook failed');
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

// ============================================
// Action Endpoints (manual triggers)
// ============================================

app.post('/actions/collect', async (_req: Request, res: Response) => {
  try {
    log.info('Manual fee collection triggered');
    const result = await collectAllFees();
    res.json(result);
  } catch (error) {
    log.error({ error }, 'Manual fee collection failed');
    res.status(500).json({ error: 'Fee collection failed' });
  }
});

app.post('/actions/buyback', async (req: Request, res: Response) => {
  try {
    const { amount, multiToken } = req.body;
    log.info({ amount, multiToken }, 'Manual buyback triggered');

    // Use multi-token by default if no amount specified
    if (multiToken !== false && !amount) {
      const result = await executeMultiBuyback();
      res.json(result);
    } else {
      const result = await executeBuyback(amount);
      res.json(result);
    }
  } catch (error) {
    log.error({ error }, 'Manual buyback failed');
    res.status(500).json({ error: 'Buyback failed' });
  }
});

app.post('/actions/burn', async (req: Request, res: Response) => {
  try {
    const { amount, buybackId, multiToken } = req.body;
    log.info({ amount, buybackId, multiToken }, 'Manual burn triggered');

    // Use multi-token by default
    if (multiToken !== false && !amount) {
      const result = await burnAllTokens();
      res.json(result);
    } else {
      const result = await burnTokens(amount, buybackId);
      res.json(result);
    }
  } catch (error) {
    log.error({ error }, 'Manual burn failed');
    res.status(500).json({ error: 'Burn failed' });
  }
});

app.get('/actions/buyback/check', async (_req: Request, res: Response) => {
  try {
    const result = await shouldExecuteBuyback();
    res.json(result);
  } catch (error) {
    log.error({ error }, 'Buyback check failed');
    res.status(500).json({ error: 'Buyback check failed' });
  }
});

// Get buyback allocations (how SOL will be distributed)
app.get('/actions/buyback/allocations', async (_req: Request, res: Response) => {
  try {
    const allocations = await getBuybackAllocations();
    res.json(allocations);
  } catch (error) {
    log.error({ error }, 'Failed to get buyback allocations');
    res.status(500).json({ error: 'Failed to get allocations' });
  }
});

// Trigger marketcap update
app.post('/actions/marketcap', async (_req: Request, res: Response) => {
  try {
    log.info('Manual marketcap update triggered');
    const result = await updateAllMarketcaps();
    res.json(result);
  } catch (error) {
    log.error({ error }, 'Marketcap update failed');
    res.status(500).json({ error: 'Marketcap update failed' });
  }
});

// Trigger pool discovery
app.post('/actions/discovery', async (_req: Request, res: Response) => {
  try {
    log.info('Manual pool discovery triggered');
    const result = await discoverPlatformPools();
    res.json(result);
  } catch (error) {
    log.error({ error }, 'Pool discovery failed');
    res.status(500).json({ error: 'Discovery failed' });
  }
});

// ============================================
// Scheduler Endpoints
// ============================================

app.get('/scheduler/status', (_req: Request, res: Response) => {
  const status = getSchedulerStatus();
  res.json(status);
});

app.post('/scheduler/trigger/:task', async (req: Request, res: Response) => {
  try {
    const taskName = req.params.task as 'fee_collection' | 'buyback' | 'marketcap' | 'discovery' | 'retry';
    const validTasks = ['fee_collection', 'buyback', 'marketcap', 'discovery', 'retry'];

    if (!validTasks.includes(taskName)) {
      res.status(400).json({ error: `Invalid task name. Valid: ${validTasks.join(', ')}` });
      return;
    }

    log.info({ task: taskName }, 'Manual task trigger requested');
    await triggerTask(taskName);
    res.json({ success: true, task: taskName });
  } catch (error) {
    log.error({ error }, 'Task trigger failed');
    res.status(500).json({ error: 'Task trigger failed' });
  }
});

// ============================================
// Creator Rewards Endpoints
// ============================================

app.get('/pools/creator/:walletAddress', async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.params;
    
    if (!walletAddress) {
      res.status(400).json({ error: 'Wallet address required' });
      return;
    }

    const supabase = getSupabaseUntyped();
    const { data, error } = await supabase
      .from('flywheel_pools')
      .select('*')
      .eq('creator', walletAddress)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Return pools with migration status info
    const poolsWithInfo = (data || []).map((pool: Record<string, unknown>) => ({
      ...pool,
      rewards_available: pool.is_migrated === true && pool.damm_pool_address !== null,
    }));

    res.json({
      pools: poolsWithInfo,
      total_pools: poolsWithInfo.length,
      migrated_pools: poolsWithInfo.filter((p: { rewards_available: boolean }) => p.rewards_available).length,
    });
  } catch (error) {
    log.error({ error }, 'Failed to get creator pools');
    res.status(500).json({ error: 'Failed to get creator pools' });
  }
});

// ============================================
// Fee Claims & Buybacks History
// ============================================

app.get('/history/fees', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const supabase = getSupabaseUntyped();

    const { data, error } = await supabase
      .from('fee_claims')
      .select('*, flywheel_pools(name, symbol)')
      .order('claimed_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(data);
  } catch (error) {
    log.error({ error }, 'Failed to get fee history');
    res.status(500).json({ error: 'Failed to get fee history' });
  }
});

app.get('/history/buybacks', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const supabase = getSupabaseUntyped();

    const { data, error } = await supabase
      .from('buybacks')
      .select('*')
      .order('executed_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(data);
  } catch (error) {
    log.error({ error }, 'Failed to get buyback history');
    res.status(500).json({ error: 'Failed to get buyback history' });
  }
});

app.get('/history/burns', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const supabase = getSupabaseUntyped();

    const { data, error } = await supabase
      .from('burns')
      .select('*')
      .order('burned_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json(data);
  } catch (error) {
    log.error({ error }, 'Failed to get burn history');
    res.status(500).json({ error: 'Failed to get burn history' });
  }
});

// ============================================
// Error Handler
// ============================================

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log.error({ error: err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

export function startServer(): void {
  const port = config.port;
  app.listen(port, () => {
    log.info({ port }, 'API server started');
  });
}
