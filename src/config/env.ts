import { z } from 'zod'

const duration = z.string().regex(/^\d+(ms|s|m|h|d)$/, 'must be a duration such as 15m or 30d')

const schema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_DB_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'must be a valid PostgreSQL schema name')
    .default('ownagent'),
  DATABASE_URL: z.string().url().default('postgresql://postgres:postgres@127.0.0.1:54322/postgres'),
  AUTH_JWT_SECRET: z.string().min(32),
  AUTH_JWT_PREVIOUS_SECRET: z.string().min(32).optional(),
  AUTH_JWT_ISSUER: z.string().default('ownagent'),
  AUTH_JWT_AUDIENCE: z.string().default('ownagent-api'),
  AUTH_COOKIE_ACCESS_NAME: z.string().default('ownagent_access'),
  AUTH_COOKIE_REFRESH_NAME: z.string().default('ownagent_refresh'),
  AUTH_COOKIE_SECURE: z
    .string()
    .default('false')
    .transform(value => value === 'true'),
  AUTH_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  ACCESS_TOKEN_TTL: duration.default('15m'),
  REFRESH_TOKEN_TTL: duration.default('30d'),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com/v1'),
  DEEPSEEK_MODEL: z.string().default('deepseek-chat'),
  EMBEDDING_BASE_URL: z.string().url().default('http://127.0.0.1:8002/v1'),
  EMBEDDING_MODEL: z.string().default('Qwen3-Embedding-0.6B'),
  RERANK_URL: z.string().url().default('http://127.0.0.1:8001'),
  MODEL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),
  REDIS_STREAM_AGENT: z.string().default('ownagent:agent-runs'),
  REDIS_STREAM_INGEST: z.string().default('ownagent:document-ingest'),
  REDIS_STREAM_DEAD_LETTER: z.string().default('ownagent:dead-letter'),
  REDIS_STREAM_CONTROLS: z.string().default('ownagent:agent-controls'),
  REDIS_CONSUMER_GROUP: z.string().default('ownagent-workers'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(32).default(4),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),
  LANGFUSE_TRACING: z
    .string()
    .default('true')
    .transform(value => value !== 'false'),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASE_URL: z.string().url().default('http://127.0.0.1:3001'),
  LANGFUSE_PROJECT: z.string().default('ownagent'),
  LANGFUSE_DEBUG_CONTENT: z
    .string()
    .default('false')
    .transform(value => value === 'true'),
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  WS_MAX_FRAME_BYTES: z.coerce.number().int().positive().max(2_000_000).default(256_000),
  WS_MAX_CONNECTIONS: z.coerce.number().int().positive().default(1_000),
})

export type AppConfig = z.infer<typeof schema>

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = schema.safeParse(source)
  if (!result.success) {
    const details = result.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid environment configuration: ${details}`)
  }
  return result.data
}

export function splitOrigins(value: string): string[] {
  return value
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
}

export function durationToSeconds(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value)
  if (!match) throw new Error(`Invalid duration: ${value}`)
  const amount = Number(match[1])
  const multipliers: Record<string, number> = { ms: 1 / 1000, s: 1, m: 60, h: 3600, d: 86400 }
  const multiplier = multipliers[match[2]]!
  return Math.max(1, Math.floor(amount * multiplier))
}
