import type { RunRepository } from '../modules/runs/repository.js'
import type { RedisStreams } from './redis-streams.js'

export class OutboxDispatcher {
  private timer?: NodeJS.Timeout
  private running = false
  constructor(private readonly repository: RunRepository, private readonly queue: RedisStreams, private readonly pollMs = 500) {}
  async flush() {
    const entries = await this.repository.pendingOutbox(100)
    for (const entry of entries) {
      try { await this.queue.publish(String(entry.stream), entry.payload as Record<string, unknown>); await this.repository.markOutboxPublished(String(entry.id)) } catch (error) { console.error('outbox publish failed', error) }
    }
  }
  start() { if (this.timer) return; this.running = true; const tick = async () => { if (!this.running) return; try { await this.flush() } finally { this.timer = setTimeout(tick, this.pollMs) } }; void tick() }
  async stop() { this.running = false; if (this.timer) clearTimeout(this.timer); await this.queue.close() }
}
