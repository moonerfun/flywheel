import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const mint = 'GFfc2FzPGG4P1r82bZbgWntx3nyp6sCnQpjRwqXRyqpD';

async function main() {
  const { data, error } = await supabase
    .from('flywheel_pools')
    .select('base_mint, symbol, total_supply, circulating_supply, current_price_usd, current_marketcap_usd')
    .eq('base_mint', mint)
    .single();

  if (error) {
    console.error('Error:', error);
    return;
  }

  console.log('Database data for', mint);
  console.log(JSON.stringify(data, null, 2));

  const INITIAL_SUPPLY = 1_000_000_000;
  const burnedPct = data.total_supply
    ? ((INITIAL_SUPPLY - data.total_supply) / INITIAL_SUPPLY) * 100
    : 0;
  console.log(`\nBurned percentage: ${burnedPct.toFixed(4)}%`);
}

main();
