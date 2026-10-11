export type AnswerDeltaEmitter = (delta: string) => Promise<void>

export type AnswerDeltaSink = {
  push(delta: string): Promise<void>
  flush(): Promise<void>
}

export type AnswerDeltaBatcherOptions = {
  intervalMs?: number
  maxChars?: number
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

/** Batches model deltas without delaying the model stream between flushes. */
export class AnswerDeltaBatcher implements AnswerDeltaSink {
  private buffer = ''
  private timer?: ReturnType<typeof setTimeout>
  private flushing?: Promise<void>
  private readonly intervalMs: number
  private readonly maxChars: number
  private readonly setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void

  constructor(private readonly emit: AnswerDeltaEmitter, options: AnswerDeltaBatcherOptions = {}) {
    this.intervalMs = options.intervalMs ?? 50
    this.maxChars = options.maxChars ?? 800
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  async push(delta: string): Promise<void> {
    if (!delta) return
    this.buffer += delta
    if (this.buffer.length >= this.maxChars) {
      await this.flush()
      return
    }
    if (!this.timer) {
      this.timer = this.setTimer(() => {
        this.timer = undefined
        void this.flush().catch(() => undefined)
      }, this.intervalMs)
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) await this.flushing
    if (!this.buffer) return
    if (this.timer) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    const delta = this.buffer
    this.buffer = ''
    this.flushing = this.emit(delta).finally(() => {
      this.flushing = undefined
    })
    await this.flushing
    if (this.buffer) await this.flush()
  }
}
