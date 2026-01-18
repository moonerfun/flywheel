import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';
import type { Database } from './types.js';

let supabaseInstance: SupabaseClient<Database> | null = null;

export function getSupabase(): SupabaseClient<Database> {
  if (!supabaseInstance) {
    if (!config.supabase.url || !config.supabase.serviceRoleKey) {
      throw new Error('Supabase configuration is missing');
    }
    supabaseInstance = createClient<Database>(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );
  }
  return supabaseInstance;
}

// Re-export for convenience - use this for untyped operations
export function getSupabaseUntyped() {
  return getSupabase() as SupabaseClient;
}

export { SupabaseClient };
