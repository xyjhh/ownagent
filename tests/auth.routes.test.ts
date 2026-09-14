import { describe, expect, it } from 'vitest'
import request from 'supertest'
import type { AppConfig } from '../src/config/env.js'
import { createApp } from '../src/app.js'
import { AuthService } from '../src/modules/auth/service.js'
import type { AuthRepository } from '../src/modules/auth/types.js'
import { HealthService } from '../src/health.js'

const config: AppConfig = {
  AUTH_COOKIE_ACCESS_NAME: 'ownagent_access', AUTH_COOKIE_REFRESH_NAME: 'ownagent_refresh', AUTH_COOKIE_SECURE: false, AUTH_COOKIE_SAMESITE: 'lax', WS_HEARTBEAT_INTERVAL_MS: 30000, WS_MAX_FRAME_BYTES: 256000, WS_MAX_CONNECTIONS: 1000, REDIS_STREAM_CONTROLS: 'ownagent:agent-controls',
  API_PORT: 8787, WEB_ORIGIN: 'http://localhost:3000', SUPABASE_URL: 'http://localhost:54321', SUPABASE_SERVICE_ROLE_KEY: 'test', SUPABASE_DB_SCHEMA: 'ownagent', AUTH_JWT_SECRET: 'b'.repeat(40), AUTH_JWT_ISSUER: 'ownagent', AUTH_JWT_AUDIENCE: 'ownagent-api', ACCESS_TOKEN_TTL: '15m', REFRESH_TOKEN_TTL: '30d', DEEPSEEK_API_KEY: '', DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1', DEEPSEEK_MODEL: 'deepseek-chat', EMBEDDING_BASE_URL: 'http://127.0.0.1:8002/v1', EMBEDDING_MODEL: 'Qwen3-Embedding-0.6B', RERANK_URL: 'http://127.0.0.1:8001', MODEL_TIMEOUT_MS: 50, REDIS_URL: 'redis://127.0.0.1:6379', REDIS_MAXMEMORY: '512mb', REDIS_MAXMEMORY_POLICY: 'noeviction', REDIS_DEAD_LETTER_MAXLEN: 10000, REDIS_OUTBOX_RETRY_BASE_MS: 1000, REDIS_OUTBOX_RETRY_MAX_MS: 60000, REDIS_RECLAIM_IDLE_MS: 300000, REDIS_STREAM_AGENT: 'ownagent:agent-runs', REDIS_STREAM_INGEST: 'ownagent:document-ingest', REDIS_STREAM_DEAD_LETTER: 'ownagent:dead-letter', REDIS_CONSUMER_GROUP: 'ownagent-workers', WORKER_CONCURRENCY: 4, WORKER_MAX_ATTEMPTS: 5, LANGFUSE_TRACING: false, LANGFUSE_BASE_URL: 'http://127.0.0.1:3001', LANGFUSE_PROJECT: 'ownagent', LANGFUSE_DEBUG_CONTENT: false,
} as AppConfig

describe('auth routes', () => {
  it('returns a safe 401 response without leaking details', async () => {
    const repository = { findUserByEmail: async () => null } as unknown as AuthRepository
    const auth = new AuthService(repository, config)
    const health = { ready: async () => ({ status: 'ok', dependencies: {}, modelServicesAreNonBlocking: true }) } as unknown as HealthService
    const workspaceRepository = { findMembership: async () => null } as any
    const response = await request(createApp({ config, auth, health, workspaceRepository, runService: {} as any, schemaDb: {} as any, embedding: {} as any, reranker: {} as any })).post('/api/auth/login').send({ email: 'owner@example.com', password: 'secret' })
    expect(response.status).toBe(401)
    expect(response.body.error.message).toBe('Invalid credentials')
    expect(response.body.error).not.toHaveProperty('stack')
  })

  it('requires a bearer token for /me', async () => {
    const auth = new AuthService({ findUserById: async () => null } as unknown as AuthRepository, config)
    const health = { ready: async () => ({ status: 'ok', dependencies: {}, modelServicesAreNonBlocking: true }) } as unknown as HealthService
    const workspaceRepository = { findMembership: async () => null } as any
    const response = await request(createApp({ config, auth, health, workspaceRepository, runService: {} as any, schemaDb: {} as any, embedding: {} as any, reranker: {} as any })).get('/api/auth/me')
    expect(response.status).toBe(401)
  })
})
