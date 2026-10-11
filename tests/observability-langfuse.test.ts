import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/config/env.js'

const state = vi.hoisted(() => ({ traces: [] as any[], flushes: 0, shutdowns: 0, failFlush: false }))

vi.mock('langfuse', () => ({
  Langfuse: class {
    constructor(_options: unknown) {}
    trace(input: any) {
      const trace = {
        input,
        spans: [] as any[],
        generations: [] as any[],
        events: [] as any[],
        updates: [] as any[],
        span: (body: any) => {
          const observation = { id: `span-${trace.spans.length + 1}`, body, ended: [] as any[] }
          trace.spans.push(observation)
          return { ...observation, end: (value: any) => observation.ended.push(value) }
        },
        generation: (body: any) => {
          const observation = { id: `generation-${trace.generations.length + 1}`, body, ended: [] as any[] }
          trace.generations.push(observation)
          return { ...observation, end: (value: any) => observation.ended.push(value) }
        },
        event: (body: any) => trace.events.push(body),
        update: (body: any) => trace.updates.push(body),
      }
      state.traces.push(trace)
      return trace
    }
    async flushAsync() { state.flushes += 1; if (state.failFlush) throw new Error('telemetry unavailable') }
    async shutdownAsync() { state.shutdowns += 1 }
  },
}))

import { LangfuseTracer } from '../src/observability/langfuse.js'

const config = (overrides: Partial<AppConfig> = {}) => ({
  LANGFUSE_TRACING: true,
  LANGFUSE_PUBLIC_KEY: 'pk-test',
  LANGFUSE_SECRET_KEY: 'sk-test',
  LANGFUSE_BASE_URL: 'http://localhost:3001',
  LANGFUSE_PROJECT: 'test',
  LANGFUSE_DEBUG_CONTENT: false,
  LANGFUSE_CAPTURE_CONTENT: true,
  ...overrides,
}) as AppConfig

describe('LangfuseTracer', () => {
  beforeEach(() => {
    state.traces.length = 0
    state.flushes = 0
    state.shutdowns = 0
    state.failFlush = false
  })

  it('is a no-op when tracing is not configured', async () => {
    const tracer = new LangfuseTracer(config({ LANGFUSE_TRACING: false }))
    expect(tracer.startTrace({ id: 'run-1', name: 'test' })).toBeNull()
    await expect(tracer.flushAsync()).resolves.toBeUndefined()
  })

  it('creates nested spans and generations and updates trace output separately', () => {
    const tracer = new LangfuseTracer(config())
    const trace = tracer.startTrace({ id: 'run-1', name: 'test', workspaceId: 'workspace-1' })!
    const span = trace.span('node', { node: 'answer' })!
    const generation = trace.generation('model', [{ role: 'user', content: 'hello' }])!
    span.end({ ok: true })
    generation.end('answer')
    trace.update({ status: 'completed', output: 'answer', statusMessage: 'done' })
    expect(state.traces).toHaveLength(1)
    expect(state.traces[0].spans[0].body.name).toBe('node')
    expect(state.traces[0].generations[0].body.name).toBe('model')
    expect(state.traces[0].updates[0]).toMatchObject({ output: 'answer', metadata: { status: 'completed', statusMessage: 'done' } })
  })

  it('redacts generation content when capture is disabled', () => {
    const tracer = new LangfuseTracer(config({ LANGFUSE_CAPTURE_CONTENT: false }))
    const trace = tracer.startTrace({ id: 'run-2', name: 'test' })!
    trace.generation('model', 'private prompt')
    expect(state.traces[0].generations[0].body.input).toMatchObject({ redacted: true, length: 14 })
  })

  it('swallows flush failures', async () => {
    const tracer = new LangfuseTracer(config())
    state.failFlush = true
    await expect(tracer.flushAsync()).resolves.toBeUndefined()
  })
})
