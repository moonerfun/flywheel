-- ============================================
-- FLYWHEEL DATABASE SCHEMA
-- Multi-Token Buyback & Burn System
-- ============================================
-- Run this migration in Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- POOLS TABLE
-- Tracks all pools registered for flywheel
-- ============================================
CREATE TABLE IF NOT EXISTS flywheel_pools (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pool_address TEXT UNIQUE NOT NULL,
  base_mint TEXT NOT NULL,
  quote_mint TEXT NOT NULL,
  config_key TEXT NOT NULL,
  creator TEXT NOT NULL,
  name TEXT,
  symbol TEXT,
  is_migrated BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'migrated')),
  
  -- Marketcap tracking (for proportional buyback allocation)
  current_marketcap_usd DECIMAL(20, 2) DEFAULT 0,
  current_price_usd DECIMAL(20, 10) DEFAULT 0,
  total_supply DECIMAL(30, 9) DEFAULT 0,
  circulating_supply DECIMAL(30, 9) DEFAULT 0,
  marketcap_rank INTEGER DEFAULT 0,
  marketcap_updated_at TIMESTAMPTZ,
  
  -- Per-token flywheel statistics
  total_fees_collected_sol DECIMAL(20, 9) DEFAULT 0,
  total_tokens_bought DECIMAL(30, 9) DEFAULT 0,
  total_tokens_burned DECIMAL(30, 9) DEFAULT 0,
  last_buyback_at TIMESTAMPTZ,
  last_burn_at TIMESTAMPTZ,
  
  -- Discovery tracking
  discovery_source TEXT DEFAULT 'webhook' CHECK (discovery_source IN ('webhook', 'manual', 'on-chain')),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Pool indexes
CREATE INDEX IF NOT EXISTS idx_flywheel_pools_status ON flywheel_pools(status);
CREATE INDEX IF NOT EXISTS idx_flywheel_pools_base_mint ON flywheel_pools(base_mint);
CREATE INDEX IF NOT EXISTS idx_flywheel_pools_creator ON flywheel_pools(creator);
CREATE INDEX IF NOT EXISTS idx_flywheel_pools_config_key ON flywheel_pools(config_key);
CREATE INDEX IF NOT EXISTS idx_flywheel_pools_marketcap ON flywheel_pools(current_marketcap_usd DESC) WHERE status = 'active';

-- ============================================
-- FEE CLAIMS TABLE
-- Tracks all fee collections from pools
-- ============================================
CREATE TABLE IF NOT EXISTS fee_claims (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pool_id UUID REFERENCES flywheel_pools(id) ON DELETE CASCADE,
  pool_address TEXT NOT NULL,
  quote_amount DECIMAL(20, 9) NOT NULL, -- SOL amount (9 decimals)
  base_amount DECIMAL(20, 9) DEFAULT 0, -- Token amount
  tx_signature TEXT NOT NULL UNIQUE,
  fee_type TEXT DEFAULT 'partner' CHECK (fee_type IN ('partner', 'creator', 'protocol')),
  claimed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fee_claims_claimed_at ON fee_claims(claimed_at);
CREATE INDEX IF NOT EXISTS idx_fee_claims_pool_id ON fee_claims(pool_id);

-- ============================================
-- BUYBACKS TABLE
-- Tracks all SOL -> Token swaps (multi-token)
-- ============================================
CREATE TABLE IF NOT EXISTS buybacks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pool_id UUID REFERENCES flywheel_pools(id) ON DELETE SET NULL,
  token_mint TEXT,
  sol_amount DECIMAL(20, 9) NOT NULL,
  native_token_amount DECIMAL(20, 9) NOT NULL,
  native_token_mint TEXT NOT NULL,
  tx_signature TEXT NOT NULL UNIQUE,
  price_per_token DECIMAL(20, 9),
  slippage_bps INTEGER,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_buybacks_executed_at ON buybacks(executed_at);
CREATE INDEX IF NOT EXISTS idx_buybacks_pool_id ON buybacks(pool_id);

-- ============================================
-- BURNS TABLE
-- Tracks all token burns (multi-token)
-- ============================================
CREATE TABLE IF NOT EXISTS burns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  buyback_id UUID REFERENCES buybacks(id) ON DELETE SET NULL,
  pool_id UUID REFERENCES flywheel_pools(id) ON DELETE SET NULL,
  amount DECIMAL(20, 9) NOT NULL,
  native_token_mint TEXT NOT NULL,
  tx_signature TEXT NOT NULL UNIQUE,
  burned_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_burns_burned_at ON burns(burned_at);
CREATE INDEX IF NOT EXISTS idx_burns_pool_id ON burns(pool_id);

-- ============================================
-- FLYWHEEL STATS TABLE
-- Global aggregated statistics
-- ============================================
CREATE TABLE IF NOT EXISTS flywheel_stats (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- Singleton row
  total_fees_collected_sol DECIMAL(20, 9) DEFAULT 0,
  total_sol_used_for_buyback DECIMAL(20, 9) DEFAULT 0,
  total_tokens_bought DECIMAL(20, 9) DEFAULT 0,
  total_tokens_burned DECIMAL(20, 9) DEFAULT 0,
  total_pools INTEGER DEFAULT 0,
  active_pools INTEGER DEFAULT 0,
  total_unique_tokens INTEGER DEFAULT 0,
  total_marketcap_usd DECIMAL(30, 2) DEFAULT 0,
  avg_marketcap_usd DECIMAL(20, 2) DEFAULT 0,
  last_fee_claim_at TIMESTAMPTZ,
  last_buyback_at TIMESTAMPTZ,
  last_burn_at TIMESTAMPTZ,
  last_discovery_sync_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert initial stats row
INSERT INTO flywheel_stats (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ============================================
-- OPERATION LOGS TABLE
-- Tracks all flywheel operations for debugging
-- ============================================
CREATE TABLE IF NOT EXISTS operation_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operation_type TEXT NOT NULL CHECK (operation_type IN ('fee_claim', 'buyback', 'burn', 'register', 'discovery', 'marketcap', 'error')),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  details JSONB,
  error_message TEXT,
  tx_signature TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operation_logs_type ON operation_logs(operation_type);
CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at);

-- ============================================
-- RETRY QUEUE TABLE
-- Failed operations with exponential backoff
-- ============================================
CREATE TABLE IF NOT EXISTS retry_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operation_type TEXT NOT NULL CHECK (operation_type IN ('fee_claim', 'buyback', 'burn', 'register')),
  pool_address TEXT,
  pool_id UUID REFERENCES flywheel_pools(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}',
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 5,
  last_error TEXT,
  last_attempt_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retry_queue_status_next ON retry_queue(status, next_retry_at) WHERE status = 'pending';

-- ============================================
-- DISCOVERY SYNC TABLE
-- Tracks on-chain pool discovery runs
-- ============================================
CREATE TABLE IF NOT EXISTS discovery_sync (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  config_key TEXT NOT NULL,
  last_sync_at TIMESTAMPTZ DEFAULT NOW(),
  pools_discovered INTEGER DEFAULT 0,
  pools_new INTEGER DEFAULT 0,
  sync_status TEXT DEFAULT 'completed' CHECK (sync_status IN ('in_progress', 'completed', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_sync_config ON discovery_sync(config_key);

-- ============================================
-- MARKETCAP HISTORY TABLE
-- Historical marketcap data for analytics
-- ============================================
CREATE TABLE IF NOT EXISTS marketcap_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pool_id UUID REFERENCES flywheel_pools(id) ON DELETE CASCADE NOT NULL,
  marketcap_usd DECIMAL(20, 2) NOT NULL,
  price_usd DECIMAL(20, 10) NOT NULL,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketcap_history_pool ON marketcap_history(pool_id, recorded_at DESC);

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

-- Update stats on fee claim
CREATE OR REPLACE FUNCTION update_stats_on_fee_claim()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE flywheel_stats
  SET 
    total_fees_collected_sol = total_fees_collected_sol + NEW.quote_amount,
    last_fee_claim_at = NEW.claimed_at,
    updated_at = NOW()
  WHERE id = 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_stats_on_fee_claim
AFTER INSERT ON fee_claims
FOR EACH ROW
EXECUTE FUNCTION update_stats_on_fee_claim();

-- Update stats on buyback
CREATE OR REPLACE FUNCTION update_stats_on_buyback()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE flywheel_stats
  SET 
    total_sol_used_for_buyback = total_sol_used_for_buyback + NEW.sol_amount,
    total_tokens_bought = total_tokens_bought + NEW.native_token_amount,
    last_buyback_at = NEW.executed_at,
    updated_at = NOW()
  WHERE id = 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_stats_on_buyback
AFTER INSERT ON buybacks
FOR EACH ROW
EXECUTE FUNCTION update_stats_on_buyback();

-- Update stats on burn
CREATE OR REPLACE FUNCTION update_stats_on_burn()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE flywheel_stats
  SET 
    total_tokens_burned = total_tokens_burned + NEW.amount,
    last_burn_at = NEW.burned_at,
    updated_at = NOW()
  WHERE id = 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_stats_on_burn
AFTER INSERT ON burns
FOR EACH ROW
EXECUTE FUNCTION update_stats_on_burn();

-- Update pool counts
CREATE OR REPLACE FUNCTION update_pool_counts()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE flywheel_stats
  SET 
    total_pools = (SELECT COUNT(*) FROM flywheel_pools),
    active_pools = (SELECT COUNT(*) FROM flywheel_pools WHERE status = 'active'),
    total_unique_tokens = (SELECT COUNT(DISTINCT base_mint) FROM flywheel_pools WHERE status = 'active'),
    total_marketcap_usd = (SELECT COALESCE(SUM(current_marketcap_usd), 0) FROM flywheel_pools WHERE status = 'active'),
    avg_marketcap_usd = (SELECT COALESCE(AVG(current_marketcap_usd), 0) FROM flywheel_pools WHERE status = 'active' AND current_marketcap_usd > 0),
    updated_at = NOW()
  WHERE id = 1;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_pool_counts_insert
AFTER INSERT ON flywheel_pools
FOR EACH ROW EXECUTE FUNCTION update_pool_counts();

CREATE TRIGGER trigger_update_pool_counts_update
AFTER UPDATE ON flywheel_pools
FOR EACH ROW EXECUTE FUNCTION update_pool_counts();

CREATE TRIGGER trigger_update_pool_counts_delete
AFTER DELETE ON flywheel_pools
FOR EACH ROW EXECUTE FUNCTION update_pool_counts();

-- Update marketcap ranks
CREATE OR REPLACE FUNCTION update_marketcap_ranks()
RETURNS void AS $$
BEGIN
  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY current_marketcap_usd DESC) as rank
    FROM flywheel_pools
    WHERE status = 'active' AND current_marketcap_usd > 0
  )
  UPDATE flywheel_pools p
  SET marketcap_rank = r.rank
  FROM ranked r
  WHERE p.id = r.id;
END;
$$ LANGUAGE plpgsql;

-- Calculate buyback allocation based on marketcap
CREATE OR REPLACE FUNCTION calculate_buyback_allocation()
RETURNS TABLE(pool_id UUID, pool_address TEXT, base_mint TEXT, allocation_percent DECIMAL) AS $$
DECLARE
  total_mcap DECIMAL;
BEGIN
  SELECT COALESCE(SUM(current_marketcap_usd), 0) INTO total_mcap
  FROM flywheel_pools
  WHERE status = 'active' AND current_marketcap_usd > 0;
  
  IF total_mcap = 0 THEN
    RETURN QUERY
    SELECT fp.id, fp.pool_address, fp.base_mint, 100.0 / NULLIF(COUNT(*) OVER (), 0)
    FROM flywheel_pools fp
    WHERE fp.status = 'active';
  ELSE
    RETURN QUERY
    SELECT fp.id, fp.pool_address, fp.base_mint, (fp.current_marketcap_usd / total_mcap * 100)::DECIMAL
    FROM flywheel_pools fp
    WHERE fp.status = 'active' AND fp.current_marketcap_usd > 0;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Cleanup old marketcap history (keep 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_marketcap_history()
RETURNS void AS $$
BEGIN
  DELETE FROM marketcap_history WHERE recorded_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- VIEWS
-- ============================================

-- Buyback allocations view
CREATE OR REPLACE VIEW buyback_allocations AS
SELECT * FROM calculate_buyback_allocation();

-- Recent operations view
CREATE OR REPLACE VIEW recent_operations AS
SELECT 'fee_claim' as operation_type, fc.id, fc.quote_amount as amount, 'SOL' as currency, fc.tx_signature, fc.claimed_at as executed_at
FROM fee_claims fc
UNION ALL
SELECT 'buyback' as operation_type, b.id, b.native_token_amount as amount, 'NATIVE' as currency, b.tx_signature, b.executed_at
FROM buybacks b
UNION ALL
SELECT 'burn' as operation_type, bu.id, bu.amount, 'NATIVE' as currency, bu.tx_signature, bu.burned_at as executed_at
FROM burns bu
ORDER BY executed_at DESC;

-- Pool summary view
CREATE OR REPLACE VIEW pool_summary AS
SELECT 
  p.id,
  p.pool_address,
  p.base_mint,
  p.name,
  p.symbol,
  p.status,
  p.current_marketcap_usd,
  p.current_price_usd,
  p.marketcap_rank,
  p.total_fees_collected_sol,
  p.total_tokens_bought,
  p.total_tokens_burned,
  p.created_at,
  COUNT(fc.id) as claim_count,
  MAX(fc.claimed_at) as last_claim_at
FROM flywheel_pools p
LEFT JOIN fee_claims fc ON fc.pool_id = p.id
GROUP BY p.id;

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

-- Enable RLS on all tables
ALTER TABLE flywheel_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE buybacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE burns ENABLE ROW LEVEL SECURITY;
ALTER TABLE flywheel_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE retry_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketcap_history ENABLE ROW LEVEL SECURITY;

-- Service role policies (full access)
CREATE POLICY "service_flywheel_pools" ON flywheel_pools FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_fee_claims" ON fee_claims FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_buybacks" ON buybacks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_burns" ON burns FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_flywheel_stats" ON flywheel_stats FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_operation_logs" ON operation_logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_retry_queue" ON retry_queue FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_discovery_sync" ON discovery_sync FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_marketcap_history" ON marketcap_history FOR ALL USING (true) WITH CHECK (true);

-- Public read policies (for dashboards)
CREATE POLICY "anon_read_flywheel_stats" ON flywheel_stats FOR SELECT USING (true);
CREATE POLICY "anon_read_flywheel_pools" ON flywheel_pools FOR SELECT USING (true);
CREATE POLICY "anon_read_buybacks" ON buybacks FOR SELECT USING (true);
CREATE POLICY "anon_read_burns" ON burns FOR SELECT USING (true);

-- ============================================
-- GRANTS
-- ============================================
GRANT ALL ON flywheel_pools TO service_role;
GRANT ALL ON fee_claims TO service_role;
GRANT ALL ON buybacks TO service_role;
GRANT ALL ON burns TO service_role;
GRANT ALL ON flywheel_stats TO service_role;
GRANT ALL ON operation_logs TO service_role;
GRANT ALL ON retry_queue TO service_role;
GRANT ALL ON discovery_sync TO service_role;
GRANT ALL ON marketcap_history TO service_role;
GRANT ALL ON buyback_allocations TO service_role;
GRANT ALL ON recent_operations TO service_role;
GRANT ALL ON pool_summary TO service_role;

GRANT SELECT ON flywheel_pools TO anon;
GRANT SELECT ON flywheel_stats TO anon;
GRANT SELECT ON buybacks TO anon;
GRANT SELECT ON burns TO anon;
GRANT SELECT ON buyback_allocations TO anon;
GRANT SELECT ON pool_summary TO anon;
