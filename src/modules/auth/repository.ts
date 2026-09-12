import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuthRepository, RefreshTokenRecord, UserRecord } from './types.js'

function databaseError(error: { message?: string } | null, operation: string): never {
  throw new Error(`Supabase ${operation} failed: ${error?.message ?? 'unknown error'}`)
}

export class SupabaseAuthRepository implements AuthRepository {
  constructor(private readonly db: SupabaseClient) {}

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const { data, error } = await this.db
      .from('app_users')
      .select('*')
      .eq('email', email)
      .maybeSingle()
    if (error) databaseError(error, 'user lookup')
    return data ? this.toUser(data) : null
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const { data, error } = await this.db.from('app_users').select('*').eq('id', id).maybeSingle()
    if (error) databaseError(error, 'user lookup')
    return data ? this.toUser(data) : null
  }

  async createUser(input: { email: string; passwordHash: string }): Promise<UserRecord> {
    const { data, error } = await this.db
      .from('app_users')
      .insert({ email: input.email, password_hash: input.passwordHash })
      .select('*')
      .single()
    if (error) databaseError(error, 'user creation')
    return this.toUser(data)
  }

  async updateLastLogin(id: string, at: string): Promise<void> {
    const { error } = await this.db.from('app_users').update({ last_login_at: at }).eq('id', id)
    if (error) databaseError(error, 'last-login update')
  }

  async findRefreshTokenByHash(hash: string): Promise<RefreshTokenRecord | null> {
    const { data, error } = await this.db
      .from('auth_refresh_tokens')
      .select('*')
      .eq('token_hash', hash)
      .maybeSingle()
    if (error) databaseError(error, 'refresh-token lookup')
    return data ? this.toRefreshToken(data) : null
  }

  async createRefreshToken(input: {
    id: string
    familyId: string
    userId: string
    tokenHash: string
    expiresAt: string
    sessionId?: string
  }): Promise<RefreshTokenRecord> {
    const { data, error } = await this.db
      .from('auth_refresh_tokens')
      .insert({
        id: input.id,
        family_id: input.familyId,
        user_id: input.userId,
        token_hash: input.tokenHash,
        expires_at: input.expiresAt,
        session_id: input.sessionId ?? input.id,
      })
      .select('*')
      .single()
    if (error) databaseError(error, 'refresh-token creation')
    return this.toRefreshToken(data)
  }

  async revokeRefreshToken(id: string, replacedBy?: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('auth_refresh_tokens')
      .update({ revoked_at: new Date().toISOString(), replaced_by: replacedBy ?? null })
      .eq('id', id)
      .is('revoked_at', null)
      .select('id')
    if (error) databaseError(error, 'refresh-token revocation')
    return Boolean(data?.length)
  }

  async revokeRefreshTokenFamily(familyId: string): Promise<void> {
    const { error } = await this.db
      .from('auth_refresh_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('family_id', familyId)
      .is('revoked_at', null)
    if (error) databaseError(error, 'refresh-token family revocation')
  }

  async createSession(input: { id: string; userId: string; userAgent?: string; ipHash?: string }): Promise<void> {
    const { error } = await this.db.from('auth_sessions').insert({ id: input.id, user_id: input.userId, user_agent: input.userAgent ?? null, ip_hash: input.ipHash ?? null })
    if (error) databaseError(error, 'session creation')
  }

  async revokeSession(id: string): Promise<void> {
    const { error } = await this.db.from('auth_sessions').update({ revoked_at: new Date().toISOString() }).eq('id', id).is('revoked_at', null)
    if (error) databaseError(error, 'session revocation')
  }

  async findSession(id: string): Promise<{ revokedAt: string | null } | null> {
    const { data, error } = await this.db.from('auth_sessions').select('revoked_at').eq('id', id).maybeSingle()
    if (error) databaseError(error, 'session lookup')
    return data ? { revokedAt: data.revoked_at ? String(data.revoked_at) : null } : null
  }

  private toUser(row: Record<string, unknown>): UserRecord {
    return {
      id: String(row.id),
      email: String(row.email),
      createdAt: String(row.created_at),
      passwordHash: String(row.password_hash),
      isActive: Boolean(row.is_active),
      lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
    }
  }

  private toRefreshToken(row: Record<string, unknown>): RefreshTokenRecord {
    return {
      id: String(row.id),
      familyId: String(row.family_id),
      userId: String(row.user_id),
      tokenHash: String(row.token_hash),
      expiresAt: String(row.expires_at),
      revokedAt: row.revoked_at ? String(row.revoked_at) : null,
      replacedBy: row.replaced_by ? String(row.replaced_by) : null,
      sessionId: row.session_id ? String(row.session_id) : null,
    }
  }
}
