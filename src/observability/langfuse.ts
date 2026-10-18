import { createHash } from 'node:crypto'
import { Langfuse } from 'langfuse'
import type { AppConfig } from '../config/env.js'

export type TraceContext = {
  traceId: string
  runId?: string
  workspaceId?: string
  conversationId?: string
  parentObservationId?: string
}

export type TraceMetadata = Record<string, unknown>

export type TraceObservation = {
  id: string
  context: TraceContext
  end(output?: unknown, metadata?: TraceMetadata): void
  fail(error: unknown, metadata?: TraceMetadata): void
}

export type TraceHandle = {
  traceId: string
  context: TraceContext
  span(name: string, metadata?: TraceMetadata): TraceObservation | null
  generation(name: string, input?: unknown, metadata?: TraceMetadata): TraceObservation | null
  event(name: string, metadata?: TraceMetadata): void
  update(result: Record<string, unknown>): void
}

type StartTraceInput = {
  id: string
  name: string
  userId?: string
  workspaceId?: string
  conversationId?: string
  requestId?: string
  model?: string
  promptVersion?: string
  metadata?: TraceMetadata
}

/** Best-effort Langfuse adapter. It must never change product behavior. */
export class LangfuseTracer {
  private readonly client: any
  private readonly captureContent: boolean

  constructor(private readonly config: AppConfig) {
    this.captureContent = config.LANGFUSE_CAPTURE_CONTENT ?? config.LANGFUSE_DEBUG_CONTENT
    this.client =
      config.LANGFUSE_TRACING && config.LANGFUSE_PUBLIC_KEY && config.LANGFUSE_SECRET_KEY
        ? new Langfuse({
            publicKey: config.LANGFUSE_PUBLIC_KEY,
            secretKey: config.LANGFUSE_SECRET_KEY,
            baseUrl: config.LANGFUSE_BASE_URL,
            environment: process.env.NODE_ENV ?? 'development',
            release: process.env.npm_package_version ?? 'ownagent',
          })
        : null
  }

  isConfigured() {
    return Boolean(this.client)
  }

  startTrace(input: StartTraceInput): TraceHandle | null {
    if (!this.client) return null
    try {
      const context: TraceContext = {
        traceId: input.id,
        runId: input.id,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
      }
      const trace = this.client.trace({
        id: input.id,
        name: input.name,
        userId: input.userId ? hashId(input.userId) : undefined,
        sessionId: input.conversationId ?? input.workspaceId,
        metadata: {
          ...input.metadata,
          runId: input.id,
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          requestId: input.requestId,
          model: input.model,
          promptVersion: input.promptVersion,
          environment: process.env.NODE_ENV ?? 'development',
          release: process.env.npm_package_version ?? 'ownagent',
          langfuseProject: this.config.LANGFUSE_PROJECT,
        },
      })
      return this.wrapTrace(trace, context)
    } catch {
      return null
    }
  }

  startSpan(context: TraceContext, name: string, metadata?: TraceMetadata) {
    if (!this.client) return null
    try {
      const trace = this.client.trace({ id: context.traceId })
      return this.wrapObservation(
        trace.span({
          name,
          parentObservationId: context.parentObservationId,
          metadata: this.safeMetadata(metadata),
        }),
        context
      )
    } catch {
      return null
    }
  }

  startGeneration(context: TraceContext, name: string, input?: unknown, metadata?: TraceMetadata) {
    if (!this.client) return null
    try {
      const trace = this.client.trace({ id: context.traceId })
      return this.wrapObservation(
        trace.generation({
          name,
          input: this.safeContent(input),
          parentObservationId: context.parentObservationId,
          metadata: this.safeMetadata(metadata),
        }),
        context
      )
    } catch {
      return null
    }
  }

  async flushAsync() {
    if (!this.client) return
    try {
      await this.client.flushAsync()
    } catch {
      /* observability is non-blocking */
    }
  }

  async shutdownAsync() {
    if (!this.client) return
    try {
      await this.client.shutdownAsync()
    } catch {
      /* ignore shutdown telemetry failures */
    }
  }

  private wrapTrace(trace: any, context: TraceContext): TraceHandle {
    return {
      traceId: context.traceId,
      context,
      span: (name, metadata) =>
        this.wrapObservation(trace.span({ name, metadata: this.safeMetadata(metadata) }), context),
      generation: (name, input, metadata) =>
        this.wrapObservation(
          trace.generation({
            name,
            input: this.safeContent(input),
            metadata: this.safeMetadata(metadata),
          }),
          context
        ),
      event: (name, metadata) => {
        try {
          trace.event({ name, metadata: this.safeMetadata(metadata) })
        } catch {
          /* best effort */
        }
      },
      update: result => {
        try {
          const { output, statusMessage, metadata, ...rest } = result
          trace.update({
            ...(output !== undefined ? { output: this.safeContent(output) } : {}),
            metadata: this.safeMetadata({
              ...rest,
              ...(metadata && typeof metadata === 'object' ? metadata : {}),
              ...(statusMessage !== undefined ? { statusMessage: String(statusMessage) } : {}),
            }),
          })
        } catch {
          /* best effort */
        }
      },
    }
  }

  private wrapObservation(observation: any, context: TraceContext): TraceObservation | null {
    if (!observation) return null
    return {
      id: String(observation.id ?? ''),
      context: { ...context, parentObservationId: String(observation.id ?? '') },
      end: (output, metadata) => {
        try {
          observation.end({
            output: this.safeContent(output),
            metadata: this.safeMetadata(metadata),
          })
        } catch {
          /* best effort */
        }
      },
      fail: (error, metadata) => {
        try {
          observation.end({
            level: 'ERROR',
            statusMessage: error instanceof Error ? error.message : String(error),
            metadata: this.safeMetadata(metadata),
          })
        } catch {
          /* best effort */
        }
      },
    }
  }

  private safeContent(value: unknown) {
    if (value === undefined) return undefined
    if (this.captureContent) return value
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    return {
      redacted: true,
      length: serialized?.length ?? 0,
      sha256: createHash('sha256')
        .update(serialized ?? '')
        .digest('hex'),
    }
  }

  private safeMetadata(value?: TraceMetadata) {
    return value
  }
}

function hashId(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}
