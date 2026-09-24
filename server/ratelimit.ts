/** Sliding-window limiter kept in memory; one instance per route class. */
export class RateLimiter {
  private hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 20_000,
  ) {}

  check(key: string, now = Date.now()): { ok: boolean; retryAfter: number } {
    const since = now - this.windowMs
    const live = (this.hits.get(key) ?? []).filter((t) => t > since)
    if (live.length >= this.limit) {
      this.hits.set(key, live)
      const retryAfter = Math.max(1, Math.ceil((live[0]! + this.windowMs - now) / 1000))
      return { ok: false, retryAfter }
    }
    live.push(now)
    this.hits.set(key, live)
    if (this.hits.size > this.maxKeys) this.sweep(since)
    return { ok: true, retryAfter: 0 }
  }

  private sweep(since: number): void {
    for (const [k, v] of this.hits) {
      const live = v.filter((t) => t > since)
      if (live.length === 0) this.hits.delete(k)
      else this.hits.set(k, live)
    }
    // Still too large: drop the oldest keys (Map preserves insertion order).
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value
      if (oldest === undefined) break
      this.hits.delete(oldest)
    }
  }
}
