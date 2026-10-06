export type WorkerTask<T> = () => Promise<T>

export type WorkerPoolOptions = {
  concurrency: number
  stopping: () => boolean
  onTaskStarted?: () => void
  onTaskFinished?: () => void
}

/** Runs tasks from an async source while keeping a strict bounded pool. */
export async function runBoundedPool<T>(
  next: (count: number) => Promise<WorkerTask<T>[]>,
  options: WorkerPoolOptions
): Promise<void> {
  const active = new Set<Promise<T>>()
  const launch = (task: WorkerTask<T>) => {
    options.onTaskStarted?.()
    const promise = task().finally(() => {
      active.delete(promise)
      options.onTaskFinished?.()
    })
    active.add(promise)
  }

  while (!options.stopping()) {
    while (!options.stopping() && active.size < options.concurrency) {
      const tasks = await next(options.concurrency - active.size)
      if (!tasks.length) break
      tasks.forEach(launch)
    }
    if (active.size) await Promise.race(active)
  }
  await Promise.allSettled(active)
}

export async function waitForTasks(
  tasks: Iterable<Promise<unknown>>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<boolean> {
  const pending = Promise.allSettled(tasks)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const result = await Promise.race([pending.then(() => 'completed' as const), timeout])
  if (timer) clearTimeout(timer)
  if (result === 'timeout') {
    onTimeout()
    return false
  }
  return true
}
