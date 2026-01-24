-- ============================================
-- ADD ICON AND VOLUME FIELDS TO FLYWHEEL_POOLS
-- Run this migration in Supabase SQL Editor
-- ============================================

-- Add icon URL field
ALTER TABLE flywheel_pools 
ADD COLUMN IF NOT EXISTS icon TEXT;

-- Add 24h volume field  
ALTER TABLE flywheel_pools 
ADD COLUMN IF NOT EXISTS volume_24h DECIMAL(20, 2) DEFAULT 0;

-- Add liquidity field
ALTER TABLE flywheel_pools 
ADD COLUMN IF NOT EXISTS liquidity DECIMAL(20, 2) DEFAULT 0;

-- Add holder count
ALTER TABLE flywheel_pools 
ADD COLUMN IF NOT EXISTS holder_count INTEGER DEFAULT 0;

-- Add social links
ALTER TABLE flywheel_pools 
ADD COLUMN IF NOT EXISTS twitter TEXT;

ALTER TABLE flywheel_pools 
ADD COLUMN IF NOT EXISTS telegram TEXT;

ALTER TABLE flywheel_pools 
ADD COLUMN IF NOT EXISTS website TEXT;

-- Comment on columns
COMMENT ON COLUMN flywheel_pools.icon IS 'Token icon/logo URL';
COMMENT ON COLUMN flywheel_pools.volume_24h IS '24 hour trading volume in USD';
COMMENT ON COLUMN flywheel_pools.liquidity IS 'Current liquidity in USD';
COMMENT ON COLUMN flywheel_pools.holder_count IS 'Number of token holders';
