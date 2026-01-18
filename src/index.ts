import { config, validateConfig } from './config/index.js';
import { logger } from './utils/logger.js';
import { startServer } from './api/index.js';
import { startScheduler, stopScheduler } from './scheduler/index.js';
import { getFlywheelWallet, getWalletBalance } from './solana/index.js';

const log = logger.child({ module: 'main' });

async function main(): Promise<void> {
  log.info('Starting Flywheel Service');

  // Validate configuration
  try {
    validateConfig();
    log.info('Configuration validated');
  } catch (error) {
    log.error({ error }, 'Configuration validation failed');
    process.exit(1);
  }

  // Log wallet info
  try {
    const wallet = getFlywheelWallet();
    const balance = await getWalletBalance();
    log.info(
      {
        wallet: wallet.publicKey.toString(),
        balance: `${balance} SOL`,
        nativeToken: config.token.nativeMint,
      },
      'Flywheel wallet loaded'
    );
  } catch (error) {
    log.error({ error }, 'Failed to load wallet');
    process.exit(1);
  }

  // Start scheduler
  startScheduler();

  // Start API server
  startServer();

  // Graceful shutdown
  const shutdown = (): void => {
    log.info('Shutting down...');
    stopScheduler();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log.info('Flywheel Service started successfully');
}

main().catch((error) => {
  log.error({ error }, 'Fatal error');
  process.exit(1);
});
