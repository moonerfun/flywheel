import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function migrate() {
  const log = logger.child({ module: 'migrate' });

  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    log.error('Missing Supabase configuration. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const migrationsDir = path.join(__dirname, 'migrations');
  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  log.info(`Found ${migrationFiles.length} migration files`);

  for (const file of migrationFiles) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    log.info(`Running migration: ${file}`);

    const { error } = await supabase.rpc('exec_sql', { sql_query: sql }).single();

    if (error) {
      // Try running directly if RPC doesn't exist
      log.warn(`RPC failed, attempting direct execution...`);
      console.log('\n⚠️  Please run the following SQL in your Supabase SQL Editor:\n');
      console.log('='.repeat(60));
      console.log(sql);
      console.log('='.repeat(60));
      console.log('\nMigration file:', filePath);
    } else {
      log.info(`✓ Migration ${file} completed successfully`);
    }
  }

  log.info('Migration process complete');
}

migrate().catch(console.error);
