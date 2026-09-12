import { Langfuse } from 'langfuse'
import type { AppConfig } from '../config/env.js'

export class LangfuseTracer {
  private readonly client: any
  constructor(private readonly config: AppConfig) {
    this.client = config.LANGFUSE_TRACING && config.LANGFUSE_PUBLIC_KEY && config.LANGFUSE_SECRET_KEY
      ? new Langfuse({ publicKey: config.LANGFUSE_PUBLIC_KEY, secretKey: config.LANGFUSE_SECRET_KEY, baseUrl: config.LANGFUSE_BASE_URL, environment: 'production', release: 'ownagent' })
      : null
  }
  isConfigured() { return Boolean(this.client) }
  startTrace(input: { id: string; name: string; userId: string; workspaceId: string; requestId?: string; model?: string; promptVersion?: string }) {
    if (!this.client) return null
    return this.client.trace({ id: input.id, name: input.name, userId: hashId(input.userId), sessionId: input.workspaceId, metadata: { requestId: input.requestId, workspaceId: input.workspaceId, model: input.model, promptVersion: input.promptVersion } })
  }
  async flush() { if (this.client) await this.client.shutdownAsync() }
}

function hashId(value: string) { let hash = 2166136261; for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619); return (hash >>> 0).toString(16) }
