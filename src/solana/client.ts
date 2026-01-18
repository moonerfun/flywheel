import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../config/index.js';

let connectionInstance: Connection | null = null;
let walletInstance: Keypair | null = null;

export function getConnection(): Connection {
  if (!connectionInstance) {
    connectionInstance = new Connection(config.solana.rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
  }
  return connectionInstance;
}

export function getFlywheelWallet(): Keypair {
  if (!walletInstance) {
    if (!config.solana.flywheelPrivateKey) {
      throw new Error('FLYWHEEL_PRIVATE_KEY not configured');
    }
    
    const keyString = config.solana.flywheelPrivateKey.trim();
    let secretKey: Uint8Array;
    
    // Support both JSON array format [1,2,3,...] and Base58 format
    if (keyString.startsWith('[')) {
      // JSON array format (e.g., from solana-keygen)
      const keyArray = JSON.parse(keyString) as number[];
      secretKey = Uint8Array.from(keyArray);
    } else {
      // Base58 encoded format
      secretKey = bs58.decode(keyString);
    }
    
    walletInstance = Keypair.fromSecretKey(secretKey);
  }
  return walletInstance;
}

export async function getWalletBalance(): Promise<number> {
  const connection = getConnection();
  const wallet = getFlywheelWallet();
  const balance = await connection.getBalance(wallet.publicKey);
  return balance / 1e9; // Convert lamports to SOL
}
