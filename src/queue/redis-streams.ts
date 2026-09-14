import { Redis } from 'ioredis'
import type { AppConfig } from '../config/env.js'

export type StreamMessage = { id: string; values: Record<string, string> }

export type StreamStats = {
  length: number
  pendingCount: number
  oldestPendingIdleMs: number
}

export type RedisMemoryStats = {
  usedMemory: number
  maxMemory: number
  usageRatio: number | null
}

const CAPACITY_WAKEUP_CHANNEL = 'ownagent:queue-capacity'

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

  async publishDeadLetter(payload: Record<string, unknown>) {
    await this.connect()
    return this.client.xadd(
      this.config.REDIS_STREAM_DEAD_LETTER,
      'MAXLEN',
      '~',
      this.config.REDIS_DEAD_LETTER_MAXLEN,
      '*',
      'payload',
      JSON.stringify(payload)
    )
  }

  /** Acknowledge and remove a message from a single-owner execution stream. */
  async ackAndDelete(stream: string, group: string, id: string) {
    await this.connect()
    const result = await this.client.multi().xack(stream, group, id).xdel(stream, id).exec()
    const commandError = (result as Array<[Error | null, unknown]> | null)?.find(item => item[0])?.[0]
    if (commandError) throw commandError
    // Pub/Sub is only a wakeup hint. The durable Outbox remains the source of truth.
    try {
      await this.notifyCapacityReleased()
    } catch {
      /* Redis command already succeeded; the next Redis/DB wakeup will retry Outbox. */
    }
  }
  async publishEvent(runId: string, payload: Record<string, unknown>) {
    await this.connect()
    return this.client.publish(`ownagent:run-events:${runId}`, JSON.stringify(payload))
  }

  async notifyCapacityReleased() {
    await this.connect()
    return this.client.publish(CAPACITY_WAKEUP_CHANNEL, 'released')
  }

  async subscribeCapacityWakeup(onMessage: () => void): Promise<() => Promise<void>> {
    const subscriber = this.client.duplicate()
    await subscriber.connect()
    await subscriber.subscribe(CAPACITY_WAKEUP_CHANNEL)
    subscriber.on('message', () => onMessage())
    return async () => {
      await subscriber.unsubscribe(CAPACITY_WAKEUP_CHANNEL)
      await subscriber.quit()
    }
  }

  onReady(callback: () => void): () => void {
    this.client.on('ready', callback)
    return () => this.client.off('ready', callback)
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

  async touch(stream: string, group: string, consumer: string, id: string) {
    await this.connect()
    await (this.client as any).xclaim(stream, group, consumer, 0, id)
  }

  async streamStats(stream: string, group?: string): Promise<StreamStats> {
    await this.connect()
    const length = Number(await this.client.xlen(stream))
    if (!group) return { length, pendingCount: 0, oldestPendingIdleMs: 0 }
    const pending = (await (this.client as any).xpending(stream, group)) as [number | string, ...unknown[]]
    const pendingCount = Number(pending?.[0] ?? 0)
    let oldestPendingIdleMs = 0
    if (pendingCount > 0) {
      const first = (await (this.client as any).xpending(stream, group, '-', '+', 1)) as Array<[
        string,
        string,
        number | string,
        number | string,
      ]>
      oldestPendingIdleMs = Number(first?.[0]?.[2] ?? 0)
    }
    return { length, pendingCount, oldestPendingIdleMs }
  }

  async memoryStats(): Promise<RedisMemoryStats> {
    await this.connect()
    const info = await this.client.info('memory')
    const values = new Map<string, string>()
    for (const line of info.split('\n')) {
      const separator = line.indexOf(':')
      if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1).trim())
    }
    const usedMemory = Number(values.get('used_memory') ?? 0)
    const maxMemory = Number(values.get('maxmemory') ?? 0)
    return {
      usedMemory,
      maxMemory,
      usageRatio: maxMemory > 0 ? usedMemory / maxMemory : null,
    }
  }
  async close() {
    if (this.client.status !== 'end') await this.client.quit()
  }
}
