import type { RunRepository } from '../modules/runs/repository.js'
import type { RedisStreams } from './redis-streams.js'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'

export class OutboxDispatcher {
  private running = false
  private flushing?: Promise<void>
  private wakePending = false
  private listener?: Client
  private reconnectTimer?: NodeJS.Timeout
  private readonly workerId = `outbox-${process.pid}-${randomUUID()}`

  constructor(private readonly repository: RunRepository, private readonly queue: RedisStreams, private readonly databaseUrl: string) {}

  start() {
    if (this.running) return
    this.running = true
    void this.connectListener()
  }

  private async connectListener() {
    if (!this.running) return
    const client = new Client({ connectionString: this.databaseUrl, application_name: this.workerId })
    this.listener = client
    client.on('notification', notification => {
      if (notification.channel !== 'ownagent_outbox') return
      this.wakePending = true
      void this.flush()
    })
    client.on('error', () => this.reconnect())
    client.on('end', () => this.reconnect())
    try {
      await client.connect()
      await client.query('LISTEN ownagent_outbox')
      await this.flush()
    } catch {
      await client.end().catch(() => undefined)
      this.reconnect()
    }
  }

  private reconnect() {
    if (!this.running || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connectListener() }, 1000)
  }

  async flush() {
    if (!this.running) return
    if (this.flushing) { this.wakePending = true; return this.flushing }
    this.wakePending = false
    this.flushing = this.flushClaimed().catch(() => undefined).finally(() => {
      this.flushing = undefined
      if (this.running && this.wakePending) void this.flush()
    })
    return this.flushing
  }

  private async flushClaimed() {
    const entries = await this.repository.claimOutbox(100, this.workerId)
    for (const entry of entries) {
      try {
        await this.queue.publish(String(entry.stream), entry.payload as Record<string, unknown>)
        await this.repository.markOutboxPublished(String(entry.id), this.workerId)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'outbox publish failed'
        await this.repository.releaseOutbox(String(entry.id), this.workerId, message).catch(() => undefined)
      }
    }
  }

  async stop() {
    this.running = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const listener = this.listener
    this.listener = undefined
    if (listener) await listener.query('UNLISTEN ownagent_outbox').catch(() => undefined)
    if (listener) await listener.end().catch(() => undefined)
    await this.queue.close()
  }
}
