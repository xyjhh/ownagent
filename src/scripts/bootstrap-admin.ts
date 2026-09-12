import 'dotenv/config'
import { loadConfig } from '../config/env.js'
import { createSupabaseAdmin, createSupabaseSchemaClient } from '../infrastructure/supabase.js'
import { AuthService } from '../modules/auth/service.js'
import { SupabaseAuthRepository } from '../modules/auth/repository.js'

const config = loadConfig()
if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
  throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required for auth:bootstrap')
}

const db = createSupabaseAdmin(config)
const schemaDb = createSupabaseSchemaClient(db, config.SUPABASE_DB_SCHEMA)
const auth = new AuthService(new SupabaseAuthRepository(schemaDb), config)
const user = await auth.bootstrap(config.ADMIN_EMAIL, config.ADMIN_PASSWORD)
console.log(`Owner account created: ${user.email} (${user.id})`)
