/** Fixed-window counter keyed by an arbitrary string (room, player, IP...). */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the action is allowed (and counts it). */
  take(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count++;
    return true;
  }

  /** True if the key has used up its allowance in the current window (does not count). */
  blocked(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    return !!entry && entry.resetAt > now && entry.count >= this.limit;
  }

  private prune(now: number) {
    if (this.hits.size < 1000) return;
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
