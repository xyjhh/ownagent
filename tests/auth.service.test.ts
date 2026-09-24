import { beforeEach, describe, expect, it } from 'vitest'
import { AuthService } from '../src/modules/auth/service.js'
import type { AppConfig } from '../src/config/env.js'
import type { AuthRepository, RefreshTokenRecord, UserRecord } from '../src/modules/auth/types.js'

const config: AppConfig = {
  API_PORT: 8787,
  WEB_ORIGIN: 'http://localhost:3000',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  SUPABASE_DB_SCHEMA: 'ownagent',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  AUTH_JWT_SECRET: 'a'.repeat(40),
  AUTH_JWT_ISSUER: 'ownagent',
  AUTH_JWT_AUDIENCE: 'ownagent-api',
  AUTH_COOKIE_ACCESS_NAME: 'ownagent_access', AUTH_COOKIE_REFRESH_NAME: 'ownagent_refresh', AUTH_COOKIE_SECURE: false, AUTH_COOKIE_SAMESITE: 'lax',
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL: '30d',
  DEEPSEEK_API_KEY: '',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
  DEEPSEEK_MODEL: 'deepseek-chat',
  EMBEDDING_BASE_URL: 'http://127.0.0.1:8002/v1',
  EMBEDDING_MODEL: 'Qwen3-Embedding-0.6B',
  RERANK_URL: 'http://127.0.0.1:8001',
  MODEL_TIMEOUT_MS: 50, WS_HEARTBEAT_INTERVAL_MS: 30000, WS_MAX_FRAME_BYTES: 256000, WS_MAX_CONNECTIONS: 1000,
  REDIS_STREAM_CONTROLS: 'ownagent:agent-controls',
  REDIS_URL: 'redis://127.0.0.1:6379', REDIS_MAXMEMORY: '512mb', REDIS_MAXMEMORY_POLICY: 'noeviction', REDIS_DEAD_LETTER_MAXLEN: 10000, REDIS_OUTBOX_RETRY_BASE_MS: 1000, REDIS_OUTBOX_RETRY_MAX_MS: 60000, REDIS_RECLAIM_IDLE_MS: 300000, REDIS_STREAM_AGENT: 'ownagent:agent-runs', REDIS_STREAM_INGEST: 'ownagent:document-ingest', REDIS_STREAM_DEAD_LETTER: 'ownagent:dead-letter', REDIS_CONSUMER_GROUP: 'ownagent-workers', WORKER_CONCURRENCY: 4, CONTROL_CONCURRENCY: 2, WORKER_MAX_ATTEMPTS: 5, LANGFUSE_TRACING: false, LANGFUSE_BASE_URL: 'http://127.0.0.1:3001', LANGFUSE_PROJECT: 'ownagent', LANGFUSE_DEBUG_CONTENT: false,
}

class FakeRepository implements AuthRepository {
  users = new Map<string, UserRecord>()
  tokens = new Map<string, RefreshTokenRecord>()
  lastLogin = ''
  async findUserByEmail(email: string) { return [...this.users.values()].find(user => user.email === email) ?? null }
  async findUserById(id: string) { return this.users.get(id) ?? null }
  async createUser(input: { email: string; passwordHash: string }) {
    const user: UserRecord = { id: crypto.randomUUID(), email: input.email, passwordHash: input.passwordHash, isActive: true, lastLoginAt: null, createdAt: new Date().toISOString() }
    this.users.set(user.id, user)
    return user
  }
  async updateLastLogin(id: string, at: string) { this.lastLogin = id; const user = this.users.get(id)!; user.lastLoginAt = at }
  async findRefreshTokenByHash(hash: string) { return [...this.tokens.values()].find(token => token.tokenHash === hash) ?? null }
  async createRefreshToken(input: { id: string; familyId: string; userId: string; tokenHash: string; expiresAt: string }) {
    const record: RefreshTokenRecord = { ...input, revokedAt: null, replacedBy: null }
    this.tokens.set(record.id, record)
    return record
  }
  async revokeRefreshToken(id: string, replacedBy?: string) { const token = this.tokens.get(id); if (!token || token.revokedAt) return false; token.revokedAt = new Date().toISOString(); token.replacedBy = replacedBy ?? null; return true }
  async revokeRefreshTokenFamily(familyId: string) { for (const token of this.tokens.values()) if (token.familyId === familyId && !token.revokedAt) token.revokedAt = new Date().toISOString() }
}

describe('AuthService', () => {
  let repository: FakeRepository
  let auth: AuthService
  let user: UserRecord

  beforeEach(async () => {
    repository = new FakeRepository()
    auth = new AuthService(repository, config)
    user = await repository.createUser({ email: 'owner@example.com', passwordHash: await import('argon2').then(argon2 => argon2.default.hash('correct-password', { type: argon2.default.argon2id })) })
  })

  it('logs in and rotates refresh tokens', async () => {
    const first = await auth.login(' OWNER@example.com ', 'correct-password')
    expect(first.tokenType).toBe('Bearer')
    expect(first.user.email).toBe('owner@example.com')
    const second = await auth.refresh(first.refreshToken)
    expect(second.accessToken).not.toBe(first.accessToken)
    await expect(auth.refresh(first.refreshToken)).rejects.toMatchObject({ status: 401 })
  })

  it('rejects invalid credentials and verifies access identity', async () => {
    await expect(auth.login('owner@example.com', 'wrong-password')).rejects.toMatchObject({ status: 401 })
    const pair = await auth.login('owner@example.com', 'correct-password')
    await expect(auth.verifyAccessToken(pair.accessToken)).resolves.toMatchObject({ userId: user.id, email: user.email })
  })

  it('revokes a refresh family on token replay', async () => {
    const pair = await auth.login('owner@example.com', 'correct-password')
    const next = await auth.refresh(pair.refreshToken)
    await expect(auth.refresh(pair.refreshToken)).rejects.toMatchObject({ status: 401 })
    await expect(auth.refresh(next.refreshToken)).rejects.toMatchObject({ status: 401 })
  })
})
