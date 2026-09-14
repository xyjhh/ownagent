import { describe, expect, it, vi } from 'vitest'
import { RedisStreams } from '../src/queue/redis-streams.js'
import type { AppConfig } from '../src/config/env.js'

const config = {
  REDIS_URL: 'redis://127.0.0.1:6379',
  REDIS_MAXMEMORY: '512mb',
  REDIS_MAXMEMORY_POLICY: 'noeviction',
  REDIS_DEAD_LETTER_MAXLEN: 10_000,
  REDIS_OUTBOX_RETRY_BASE_MS: 1_000,
  REDIS_OUTBOX_RETRY_MAX_MS: 60_000,
  REDIS_RECLAIM_IDLE_MS: 300_000,
  REDIS_STREAM_DEAD_LETTER: 'ownagent:dead-letter',
} as AppConfig

describe('RedisStreams retention and acknowledgement', () => {
  it('atomically acknowledges and deletes a task, then wakes the dispatcher', async () => {
    const queue = new RedisStreams(config)
    const exec = vi.fn().mockResolvedValue([[null, 1], [null, 1]])
    const xdel = vi.fn().mockReturnValue({ exec })
    const xack = vi.fn().mockReturnValue({ xdel, exec })
    const multi = vi.fn().mockReturnValue({ xack })
    const publish = vi.fn().mockResolvedValue(1)
    const client = queue.client as any
    client.connect = vi.fn().mockResolvedValue(undefined)
    client.multi = multi
    client.publish = publish
    Object.defineProperty(client, 'status', { value: 'ready', configurable: true })

    await queue.ackAndDelete('ownagent:agent-runs', 'ownagent-workers', '1-0')

    expect(xack).toHaveBeenCalledWith('ownagent:agent-runs', 'ownagent-workers', '1-0')
    expect(xdel).toHaveBeenCalledWith('ownagent:agent-runs', '1-0')
    expect(publish).toHaveBeenCalledWith('ownagent:queue-capacity', 'released')
  })

  it('publishes dead letters with an approximate maximum length', async () => {
    const queue = new RedisStreams(config)
    const xadd = vi.fn().mockResolvedValue('1-0')
    const client = queue.client as any
    client.connect = vi.fn().mockResolvedValue(undefined)
    client.xadd = xadd
    Object.defineProperty(client, 'status', { value: 'ready', configurable: true })

    await queue.publishDeadLetter({ runId: 'run-1', code: 'AGENT_ERROR' })

    expect(xadd).toHaveBeenCalledWith(
      'ownagent:dead-letter',
      'MAXLEN',
      '~',
      10_000,
      '*',
      'payload',
      JSON.stringify({ runId: 'run-1', code: 'AGENT_ERROR' })
    )
  })
})
