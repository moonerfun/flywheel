// Database types for Supabase
// These match the schema defined in migrations/001_flywheel_schema.sql

export interface Database {
  public: {
    Tables: {
      flywheel_pools: {
        Row: {
          id: string;
          pool_address: string;
          base_mint: string;
          quote_mint: string;
          config_key: string;
          creator: string;
          name: string | null;
          symbol: string | null;
          is_migrated: boolean;
          status: 'active' | 'inactive' | 'migrated';
          // Marketcap tracking
          current_marketcap_usd: number;
          current_price_usd: number;
          total_supply: number;
          circulating_supply: number;
          marketcap_rank: number;
          marketcap_updated_at: string | null;
          // Per-token flywheel stats
          total_fees_collected_sol: number;
          total_tokens_bought: number;
          total_tokens_burned: number;
          last_buyback_at: string | null;
          last_burn_at: string | null;
          discovery_source: 'webhook' | 'manual' | 'on-chain';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          pool_address: string;
          base_mint: string;
          quote_mint: string;
          config_key: string;
          creator: string;
          name?: string | null;
          symbol?: string | null;
          is_migrated?: boolean;
          status?: 'active' | 'inactive' | 'migrated';
          current_marketcap_usd?: number;
          current_price_usd?: number;
          total_supply?: number;
          circulating_supply?: number;
          marketcap_rank?: number;
          marketcap_updated_at?: string | null;
          total_fees_collected_sol?: number;
          total_tokens_bought?: number;
          total_tokens_burned?: number;
          last_buyback_at?: string | null;
          last_burn_at?: string | null;
          discovery_source?: 'webhook' | 'manual' | 'on-chain';
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          pool_address?: string;
          base_mint?: string;
          quote_mint?: string;
          config_key?: string;
          creator?: string;
          name?: string | null;
          symbol?: string | null;
          is_migrated?: boolean;
          status?: 'active' | 'inactive' | 'migrated';
          current_marketcap_usd?: number;
          current_price_usd?: number;
          total_supply?: number;
          circulating_supply?: number;
          marketcap_rank?: number;
          marketcap_updated_at?: string | null;
          total_fees_collected_sol?: number;
          total_tokens_bought?: number;
          total_tokens_burned?: number;
          last_buyback_at?: string | null;
          last_burn_at?: string | null;
          discovery_source?: 'webhook' | 'manual' | 'on-chain';
          created_at?: string;
          updated_at?: string;
        };
      };
      fee_claims: {
        Row: {
          id: string;
          pool_id: string | null;
          pool_address: string;
          quote_amount: number;
          base_amount: number;
          tx_signature: string;
          fee_type: 'partner' | 'creator' | 'protocol';
          claimed_at: string;
        };
        Insert: {
          id?: string;
          pool_id?: string | null;
          pool_address: string;
          quote_amount: number;
          base_amount?: number;
          tx_signature: string;
          fee_type?: 'partner' | 'creator' | 'protocol';
          claimed_at?: string;
        };
        Update: {
          id?: string;
          pool_id?: string | null;
          pool_address?: string;
          quote_amount?: number;
          base_amount?: number;
          tx_signature?: string;
          fee_type?: 'partner' | 'creator' | 'protocol';
          claimed_at?: string;
        };
      };
      buybacks: {
        Row: {
          id: string;
          pool_id: string | null;
          token_mint: string | null;
          sol_amount: number;
          native_token_amount: number;
          native_token_mint: string;
          tx_signature: string;
          price_per_token: number | null;
          slippage_bps: number | null;
          executed_at: string;
        };
        Insert: {
          id?: string;
          pool_id?: string | null;
          token_mint?: string | null;
          sol_amount: number;
          native_token_amount: number;
          native_token_mint: string;
          tx_signature: string;
          price_per_token?: number | null;
          slippage_bps?: number | null;
          executed_at?: string;
        };
        Update: {
          id?: string;
          pool_id?: string | null;
          token_mint?: string | null;
          sol_amount?: number;
          native_token_amount?: number;
          native_token_mint?: string;
          tx_signature?: string;
          price_per_token?: number | null;
          slippage_bps?: number | null;
          executed_at?: string;
        };
      };
      burns: {
        Row: {
          id: string;
          buyback_id: string | null;
          pool_id: string | null;
          amount: number;
          native_token_mint: string;
          tx_signature: string;
          burned_at: string;
        };
        Insert: {
          id?: string;
          buyback_id?: string | null;
          pool_id?: string | null;
          amount: number;
          native_token_mint: string;
          tx_signature: string;
          burned_at?: string;
        };
        Update: {
          id?: string;
          buyback_id?: string | null;
          pool_id?: string | null;
          amount?: number;
          native_token_mint?: string;
          tx_signature?: string;
          burned_at?: string;
        };
      };
      flywheel_stats: {
        Row: {
          id: number;
          total_fees_collected_sol: number;
          total_sol_used_for_buyback: number;
          total_tokens_bought: number;
          total_tokens_burned: number;
          total_pools: number;
          active_pools: number;
          total_unique_tokens: number;
          total_marketcap_usd: number;
          avg_marketcap_usd: number;
          last_fee_claim_at: string | null;
          last_buyback_at: string | null;
          last_burn_at: string | null;
          last_discovery_sync_at: string | null;
          updated_at: string;
        };
        Insert: {
          id?: number;
          total_fees_collected_sol?: number;
          total_sol_used_for_buyback?: number;
          total_tokens_bought?: number;
          total_tokens_burned?: number;
          total_pools?: number;
          active_pools?: number;
          total_unique_tokens?: number;
          total_marketcap_usd?: number;
          avg_marketcap_usd?: number;
          last_fee_claim_at?: string | null;
          last_buyback_at?: string | null;
          last_burn_at?: string | null;
          last_discovery_sync_at?: string | null;
          updated_at?: string;
        };
        Update: {
          id?: number;
          total_fees_collected_sol?: number;
          total_sol_used_for_buyback?: number;
          total_tokens_bought?: number;
          total_tokens_burned?: number;
          total_pools?: number;
          active_pools?: number;
          total_unique_tokens?: number;
          total_marketcap_usd?: number;
          avg_marketcap_usd?: number;
          last_fee_claim_at?: string | null;
          last_buyback_at?: string | null;
          last_burn_at?: string | null;
          last_discovery_sync_at?: string | null;
          updated_at?: string;
        };
      };
      operation_logs: {
        Row: {
          id: string;
          operation_type: 'fee_claim' | 'buyback' | 'burn' | 'register' | 'discovery' | 'marketcap' | 'error';
          status: 'started' | 'completed' | 'failed';
          details: Record<string, unknown> | null;
          error_message: string | null;
          tx_signature: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          operation_type: 'fee_claim' | 'buyback' | 'burn' | 'register' | 'discovery' | 'marketcap' | 'error';
          status: 'started' | 'completed' | 'failed';
          details?: Record<string, unknown> | null;
          error_message?: string | null;
          tx_signature?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          operation_type?: 'fee_claim' | 'buyback' | 'burn' | 'register' | 'discovery' | 'marketcap' | 'error';
          status?: 'started' | 'completed' | 'failed';
          details?: Record<string, unknown> | null;
          error_message?: string | null;
          tx_signature?: string | null;
          created_at?: string;
        };
      };
      retry_queue: {
        Row: {
          id: string;
          operation_type: 'fee_claim' | 'buyback' | 'burn' | 'register';
          pool_address: string | null;
          pool_id: string | null;
          payload: Record<string, unknown>;
          retry_count: number;
          max_retries: number;
          last_error: string | null;
          last_attempt_at: string | null;
          next_retry_at: string;
          status: 'pending' | 'processing' | 'completed' | 'failed';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          operation_type: 'fee_claim' | 'buyback' | 'burn' | 'register';
          pool_address?: string | null;
          pool_id?: string | null;
          payload?: Record<string, unknown>;
          retry_count?: number;
          max_retries?: number;
          last_error?: string | null;
          last_attempt_at?: string | null;
          next_retry_at?: string;
          status?: 'pending' | 'processing' | 'completed' | 'failed';
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          operation_type?: 'fee_claim' | 'buyback' | 'burn' | 'register';
          pool_address?: string | null;
          pool_id?: string | null;
          payload?: Record<string, unknown>;
          retry_count?: number;
          max_retries?: number;
          last_error?: string | null;
          last_attempt_at?: string | null;
          next_retry_at?: string;
          status?: 'pending' | 'processing' | 'completed' | 'failed';
          created_at?: string;
          updated_at?: string;
        };
      };
      discovery_sync: {
        Row: {
          id: string;
          config_key: string;
          last_sync_at: string;
          pools_discovered: number;
          pools_new: number;
          sync_status: 'in_progress' | 'completed' | 'failed';
          error_message: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          config_key: string;
          last_sync_at?: string;
          pools_discovered?: number;
          pools_new?: number;
          sync_status?: 'in_progress' | 'completed' | 'failed';
          error_message?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          config_key?: string;
          last_sync_at?: string;
          pools_discovered?: number;
          pools_new?: number;
          sync_status?: 'in_progress' | 'completed' | 'failed';
          error_message?: string | null;
          created_at?: string;
        };
      };
      marketcap_history: {
        Row: {
          id: string;
          pool_id: string;
          marketcap_usd: number;
          price_usd: number;
          recorded_at: string;
        };
        Insert: {
          id?: string;
          pool_id: string;
          marketcap_usd: number;
          price_usd: number;
          recorded_at?: string;
        };
        Update: {
          id?: string;
          pool_id?: string;
          marketcap_usd?: number;
          price_usd?: number;
          recorded_at?: string;
        };
      };
    };
    Views: {
      buyback_allocations: {
        Row: {
          pool_id: string;
          pool_address: string;
          base_mint: string;
          allocation_percent: number;
        };
      };
      recent_operations: {
        Row: {
          operation_type: string;
          id: string;
          amount: number;
          currency: string;
          tx_signature: string;
          executed_at: string;
        };
      };
      pool_summary: {
        Row: {
          id: string;
          pool_address: string;
          base_mint: string;
          name: string | null;
          symbol: string | null;
          status: string;
          current_marketcap_usd: number;
          current_price_usd: number;
          marketcap_rank: number;
          total_fees_collected_sol: number;
          total_tokens_bought: number;
          total_tokens_burned: number;
          created_at: string;
          claim_count: number;
          last_claim_at: string | null;
        };
      };
    };
  };
}

// ============================================
// Utility Types (Table Row/Insert shortcuts)
// ============================================

// Pools
export type FlywheelPool = Database['public']['Tables']['flywheel_pools']['Row'];
export type FlywheelPoolInsert = Database['public']['Tables']['flywheel_pools']['Insert'];
export type FlywheelPoolUpdate = Database['public']['Tables']['flywheel_pools']['Update'];

// Fee Claims
export type FeeClaim = Database['public']['Tables']['fee_claims']['Row'];
export type FeeClaimInsert = Database['public']['Tables']['fee_claims']['Insert'];

// Buybacks
export type Buyback = Database['public']['Tables']['buybacks']['Row'];
export type BuybackInsert = Database['public']['Tables']['buybacks']['Insert'];

// Burns
export type Burn = Database['public']['Tables']['burns']['Row'];
export type BurnInsert = Database['public']['Tables']['burns']['Insert'];

// Stats
export type FlywheelStats = Database['public']['Tables']['flywheel_stats']['Row'];
export type FlywheelStatsUpdate = Database['public']['Tables']['flywheel_stats']['Update'];

// Operation Logs
export type OperationLog = Database['public']['Tables']['operation_logs']['Row'];
export type OperationLogInsert = Database['public']['Tables']['operation_logs']['Insert'];

// Retry Queue
export type RetryQueueItem = Database['public']['Tables']['retry_queue']['Row'];
export type RetryQueueInsert = Database['public']['Tables']['retry_queue']['Insert'];
export type RetryQueueUpdate = Database['public']['Tables']['retry_queue']['Update'];

// Discovery Sync
export type DiscoverySync = Database['public']['Tables']['discovery_sync']['Row'];
export type DiscoverySyncInsert = Database['public']['Tables']['discovery_sync']['Insert'];

// Marketcap History
export type MarketcapHistory = Database['public']['Tables']['marketcap_history']['Row'];
export type MarketcapHistoryInsert = Database['public']['Tables']['marketcap_history']['Insert'];

// ============================================
// View Types
// ============================================

export type BuybackAllocation = Database['public']['Views']['buyback_allocations']['Row'];
export type RecentOperation = Database['public']['Views']['recent_operations']['Row'];
export type PoolSummary = Database['public']['Views']['pool_summary']['Row'];
