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
    // Support multiple config keys separated by comma
    configKeys: (process.env.PLATFORM_CONFIG_KEY || process.env.POOL_CONFIG_KEY || '')
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0),
    // Backwards compatibility: first config key
    configKey: (process.env.PLATFORM_CONFIG_KEY || process.env.POOL_CONFIG_KEY || '').split(',')[0]?.trim() || '',
    enabled: process.env.DISCOVERY_ENABLED !== 'false', // Enable on-chain discovery
  },

  // Jupiter Ultra API
  jupiter: {
    apiUrl: process.env.JUPITER_API_URL || 'https://api.jup.ag/ultra/v1',
    apiKey: process.env.JUPITER_API_KEY || '',
  },

  // Scheduler - Staggered every 15 mins in correct order
  // Order: Discovery (0) → Marketcap (3) → Collection (6) → Buyback+Burn (10)
  scheduler: {
    discoveryCron: process.env.DISCOVERY_CRON || '0,15,30,45 * * * *', // At :00, :15, :30, :45
    marketcapCron: process.env.MARKETCAP_CRON || '3,18,33,48 * * * *', // At :03, :18, :33, :48
    feeCollectionCron: process.env.FEE_COLLECTION_CRON || '6,21,36,51 * * * *', // At :06, :21, :36, :51
    buybackCron: process.env.BUYBACK_CRON || '10,25,40,55 * * * *', // At :10, :25, :40, :55
    burnAfterBuyback: process.env.BURN_AFTER_BUYBACK !== 'false', // Default true
  },

  // Thresholds
  thresholds: {
    minBuybackSol: parseFloat(process.env.MIN_BUYBACK_THRESHOLD || '0.1'),
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || '100', 10),
    minAllocationSol: parseFloat(process.env.MIN_ALLOCATION_SOL || '0.001'), // Min SOL per token buyback
    buybackPercentage: parseFloat(process.env.BUYBACK_PERCENTAGE || '80'), // % of available SOL to use
    reserveSol: parseFloat(process.env.RESERVE_SOL || '0.1'), // SOL to always keep in wallet
  },

  // Burn Configuration
  burn: {
    // Token mints to exclude from burning (comma-separated)
    // Use NATIVE_TOKEN_MINT to exclude the native platform token
    excludeMints: (process.env.BURN_EXCLUDE_MINTS || '')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0),
    // Convenience: exclude native token from burn
    excludeNativeToken: process.env.BURN_EXCLUDE_NATIVE === 'true',
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
  if (!config.token.nativeMint && config.discovery.configKeys.length === 0) {
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
