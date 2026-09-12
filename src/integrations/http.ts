export async function fetchJson<T>(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30_000
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`)
    return (await response.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export async function probe(url: string, timeoutMs: number): Promise<'ok' | 'unavailable'> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal })
      return response.ok ? 'ok' : 'unavailable'
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return 'unavailable'
  }
}
