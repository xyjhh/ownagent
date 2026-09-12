import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AppConfig } from '../config/env.js'

export function createSupabaseAdmin(config: AppConfig): SupabaseClient {
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })
}

export function createSupabaseSchemaClient(db: SupabaseClient, schema: string): SupabaseClient {
  // Supabase's generated client type defaults to the public schema. Runtime
  // schema selection is still supported; cast here because this project has
  // no generated Database type yet.
  return db.schema(schema) as unknown as SupabaseClient
}
