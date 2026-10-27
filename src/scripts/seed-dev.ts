import dotenv from 'dotenv'
import { loadConfig } from '../config/env.js'
import { createSupabaseAdmin, createSupabaseSchemaClient } from '../infrastructure/supabase.js'
import { AuthService } from '../modules/auth/service.js'
import { SupabaseAuthRepository } from '../modules/auth/repository.js'
import { WorkspaceRepository } from '../modules/workspaces/repository.js'

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.development' })

const config = loadConfig()
if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
  throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required for seed:dev')
}

const admin = createSupabaseAdmin(config)
const db = createSupabaseSchemaClient(admin, config.SUPABASE_DB_SCHEMA)
const authRepository = new SupabaseAuthRepository(db)
const auth = new AuthService(authRepository, config)
const existingUser = await authRepository.findUserByEmail(config.ADMIN_EMAIL.toLowerCase())
const user = existingUser ?? (await auth.bootstrap(config.ADMIN_EMAIL, config.ADMIN_PASSWORD))
const workspaceRepository = new WorkspaceRepository(db)
const { data: existingWorkspace, error: workspaceLookupError } = await db
  .from('workspaces')
  .select('id')
  .eq('slug', 'dev-workspace')
  .maybeSingle()
if (workspaceLookupError)
  throw new Error(`Development workspace lookup failed: ${workspaceLookupError.message}`)

if (!existingWorkspace) {
  await workspaceRepository.create(user.id, 'Development Workspace', 'dev-workspace')
} else {
  const { data: membership, error: membershipLookupError } = await db
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', existingWorkspace.id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (membershipLookupError)
    throw new Error(`Development membership lookup failed: ${membershipLookupError.message}`)
  if (!membership) {
    const { error } = await db.from('workspace_members').insert({
      workspace_id: existingWorkspace.id,
      user_id: user.id,
      role: 'owner',
      status: 'active',
    })
    if (error) throw new Error(`Development membership creation failed: ${error.message}`)
  }
}

console.log(`Development seed ready for ${user.email}`)
