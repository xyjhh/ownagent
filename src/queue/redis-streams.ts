import { Redis } from 'ioredis'
import type { AppConfig } from '../config/env.js'

export type StreamMessage = { id: string; values: Record<string, string> }

export class RedisStreams {
  readonly client: Redis
  constructor(private readonly config: AppConfig) {
    this.client = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 })
  }
  async connect() {
    if (this.client.status === 'wait') await this.client.connect()
  }
  async health(): Promise<'ok' | 'unavailable'> {
    try {
      await this.connect()
      return (await this.client.ping()) === 'PONG' ? 'ok' : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }
  async ensureGroup(stream: string, group = this.config.REDIS_CONSUMER_GROUP) {
    await this.connect()
    try {
      await this.client.xgroup('CREATE', stream, group, '$', 'MKSTREAM')
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error
    }
  }
  async publish(stream: string, payload: Record<string, unknown>) {
    await this.connect()
    return this.client.xadd(stream, '*', 'payload', JSON.stringify(payload))
  }
  async publishEvent(runId: string, payload: Record<string, unknown>) {
    await this.connect()
    return this.client.publish(`ownagent:run-events:${runId}`, JSON.stringify(payload))
  }
  async subscribeEvents(
    runId: string,
    onMessage: (payload: Record<string, unknown>) => void
  ): Promise<() => Promise<void>> {
    const subscriber = this.client.duplicate()
    await subscriber.connect()
    const channel = `ownagent:run-events:${runId}`
    await subscriber.subscribe(channel)
    subscriber.on('message', (_channel, message) => {
      try {
        const value = JSON.parse(message) as Record<string, unknown>
        onMessage(value)
      } catch {
        /* ignore malformed event */
      }
    })
    return async () => {
      await subscriber.unsubscribe(channel)
      await subscriber.quit()
    }
  }
  async read(
    stream: string,
    group: string,
    consumer: string,
    count = 1,
    blockMs = 5000
  ): Promise<StreamMessage[]> {
    await this.connect()
    const result = (await this.client.xreadgroup(
      'GROUP',
      group,
      consumer,
      'COUNT',
      count,
      'BLOCK',
      blockMs,
      'STREAMS',
      stream,
      '>'
    )) as unknown as Array<[string, Array<[string, string[]]>]> | null
    return (
      result?.[0]?.[1]?.map(([id, values]) => ({
        id,
        values: Object.fromEntries(
          Array.from({ length: values.length / 2 }, (_, i) => [values[i * 2]!, values[i * 2 + 1]!])
        ),
      })) ?? []
    )
  }
  async ack(stream: string, group: string, id: string) {
    await this.client.xack(stream, group, id)
  }
  async reclaim(
    stream: string,
    group: string,
    consumer: string,
    minIdleMs = 60_000
  ): Promise<StreamMessage[]> {
    await this.connect()
    const result = (await (this.client as any).xautoclaim(
      stream,
      group,
      consumer,
      minIdleMs,
      '0-0',
      'COUNT',
      20
    )) as [string, Array<[string, string[]]>]
    return (
      result?.[1]?.map(([id, values]) => ({
        id,
        values: Object.fromEntries(
          Array.from({ length: values.length / 2 }, (_, i) => [values[i * 2]!, values[i * 2 + 1]!])
        ),
      })) ?? []
    )
  }
  async close() {
    if (this.client.status !== 'end') await this.client.quit()
  }
}
