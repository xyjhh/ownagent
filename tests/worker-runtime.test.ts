import { describe, expect, it, vi } from 'vitest'
import { runBoundedPool, waitForTasks } from '../src/worker-runtime.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

describe('worker runtime pools', () => {
  it('keeps the configured concurrency and refills a freed slot immediately', async () => {
    let nextId = 0
    let running = 0
    let maximum = 0
    const done = runBoundedPool(async count => {
      const tasks = Array.from({ length: Math.min(count, 5 - nextId) }, () => {
        const id = nextId++
        return async () => {
          running++
          maximum = Math.max(maximum, running)
          await Promise.resolve()
          running--
        }
      })
      return tasks
    }, { concurrency: 2, stopping: () => nextId >= 5 })

    await vi.waitFor(() => expect(nextId).toBe(2))
    await vi.waitFor(() => expect(nextId).toBe(5))
    await vi.waitFor(() => expect(running).toBe(0))
    await done
    expect(maximum).toBeLessThanOrEqual(2)
  })

  it('waits for tasks and invokes timeout cleanup only when needed', async () => {
    const task = deferred()
    const cleanup = vi.fn()
    const waiting = waitForTasks([task.promise], 10, cleanup)
    await expect(waiting).resolves.toBe(false)
    expect(cleanup).toHaveBeenCalledOnce()
    task.resolve()
  })
})
