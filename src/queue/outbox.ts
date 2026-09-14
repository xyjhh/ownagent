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
  private retryTimer?: NodeJS.Timeout
  private capacityClose?: () => Promise<void>
  private capacityConnecting?: Promise<void>
  private removeReadyListener?: () => void
  private readonly workerId = `outbox-${process.pid}-${randomUUID()}`

  constructor(
    private readonly repository: RunRepository,
    private readonly queue: RedisStreams,
    private readonly databaseUrl: string,
    private readonly retry = { baseMs: 1_000, maxMs: 60_000 }
  ) {}

  start() {
    if (this.running) return
    this.running = true
    this.removeReadyListener = this.queue.onReady(() => {
      void this.connectCapacityListener()
      void this.flush()
    })
    void this.connectListener()
    void this.connectCapacityListener()
  }

  private async connectCapacityListener() {
    if (!this.running || this.capacityClose) return
    if (this.capacityConnecting) return this.capacityConnecting
    this.capacityConnecting = (async () => {
      try {
        const close = await this.queue.subscribeCapacityWakeup(() => {
          this.wakePending = true
          void this.flush()
        })
        if (this.running) this.capacityClose = close
        else await close().catch(() => undefined)
      } catch {
        // Redis readiness events will retry this subscription without polling.
      } finally {
        this.capacityConnecting = undefined
      }
    })()
    return this.capacityConnecting
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
    this.flushing = this.flushClaimed().catch(() => {
      this.scheduleRetry(this.retry.baseMs)
    }).finally(() => {
      this.flushing = undefined
      if (this.running && this.wakePending) void this.flush()
    })
    return this.flushing
  }

  private async flushClaimed() {
    while (this.running) {
      const entries = await this.repository.claimOutbox(100, this.workerId)
      if (!entries.length) return
      for (const entry of entries) {
        try {
          await this.queue.publish(String(entry.stream), entry.payload as Record<string, unknown>)
          await this.repository.markOutboxPublished(String(entry.id), this.workerId)
        } catch (error) {
          const rawMessage = error instanceof Error ? error.message : ''
          const message = /oom|maxmemory|out of memory/i.test(rawMessage)
            ? 'REDIS_CAPACITY_REACHED'
            : 'REDIS_PUBLISH_FAILED'
          const attempt = Math.max(1, Number(entry.attempts) || 1)
          const delayMs = Math.min(
            this.retry.maxMs,
            this.retry.baseMs * 2 ** Math.min(16, attempt - 1)
          )
          await this.repository
            .releaseOutbox(String(entry.id), this.workerId, message, delayMs)
            .catch(() => undefined)
          this.scheduleRetry(delayMs)
        }
      }
    }
  }

  private scheduleRetry(delayMs: number) {
    if (!this.running) return
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.flush()
    }, Math.max(1, delayMs))
  }

  async stop() {
    this.running = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.reconnectTimer = undefined
    this.retryTimer = undefined
    this.removeReadyListener?.()
    this.removeReadyListener = undefined
    const capacityClose = this.capacityClose
    this.capacityClose = undefined
    this.capacityConnecting = undefined
    if (capacityClose) await capacityClose().catch(() => undefined)
    const listener = this.listener
    this.listener = undefined
    if (listener) await listener.query('UNLISTEN ownagent_outbox').catch(() => undefined)
    if (listener) await listener.end().catch(() => undefined)
    await this.queue.close()
  }
}
