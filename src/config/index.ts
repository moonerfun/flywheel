import 'dotenv/config';

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Supabase
  supabase: {
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  // Solana
  solana: {
    rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    rpcWssUrl: process.env.RPC_WSS_URL || 'wss://api.mainnet-beta.solana.com',
    flywheelPrivateKey: process.env.FLYWHEEL_PRIVATE_KEY || '',
  },

  // Token Configuration (optional - multi-token mode doesn't require a single native token)
  token: {
    nativeMint: process.env.NATIVE_TOKEN_MINT || '', // Optional: single native token for backwards compatibility
    poolConfigKey: process.env.POOL_CONFIG_KEY || '',
  },

  // Discovery Configuration (for on-chain pool discovery)
  discovery: {
    configKey: process.env.PLATFORM_CONFIG_KEY || process.env.POOL_CONFIG_KEY || '', // DBC config key used by the platform
    enabled: process.env.DISCOVERY_ENABLED !== 'false', // Enable on-chain discovery
  },

  // Jupiter Ultra API
  jupiter: {
    apiUrl: process.env.JUPITER_API_URL || 'https://api.jup.ag/ultra/v1',
    apiKey: process.env.JUPITER_API_KEY || '',
  },

  // Scheduler
  scheduler: {
    feeCollectionCron: process.env.FEE_COLLECTION_CRON || '0 */6 * * *', // Every 6 hours
    buybackCron: process.env.BUYBACK_CRON || '0 */12 * * *', // Every 12 hours
    marketcapCron: process.env.MARKETCAP_CRON || '0 * * * *', // Every hour
    discoveryCron: process.env.DISCOVERY_CRON || '0 */4 * * *', // Every 4 hours
    burnAfterBuyback: process.env.BURN_AFTER_BUYBACK !== 'false', // Default true
  },

  // Thresholds
  thresholds: {
    minBuybackSol: parseFloat(process.env.MIN_BUYBACK_THRESHOLD || '0.1'),
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || '100', 10),
    minAllocationSol: parseFloat(process.env.MIN_ALLOCATION_SOL || '0.001'), // Min SOL per token buyback
  },

  // Retry Configuration
  retry: {
    maxRetries: parseInt(process.env.MAX_RETRIES || '5', 10),
    backoffMultiplier: parseInt(process.env.RETRY_BACKOFF_MULTIPLIER || '2', 10),
  },
} as const;

// Validation
export function validateConfig(): void {
  const required: Array<{ key: string; value: string }> = [
    { key: 'SUPABASE_URL', value: config.supabase.url },
    { key: 'SUPABASE_SERVICE_ROLE_KEY', value: config.supabase.serviceRoleKey },
    { key: 'FLYWHEEL_PRIVATE_KEY', value: config.solana.flywheelPrivateKey },
  ];

  // NATIVE_TOKEN_MINT is no longer required for multi-token mode
  // But either NATIVE_TOKEN_MINT or PLATFORM_CONFIG_KEY should be set
  if (!config.token.nativeMint && !config.discovery.configKey) {
    console.warn(
      'Warning: Neither NATIVE_TOKEN_MINT nor PLATFORM_CONFIG_KEY is set. ' +
      'Set PLATFORM_CONFIG_KEY to enable on-chain pool discovery.'
    );
  }

  const missing = required.filter(r => !r.value);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.map(m => m.key).join(', ')}`
    );
  }
}
