/**
 * 429 backoff state machine.
 *
 * Every observed 429 extends the quiet window exponentially; any successful
 * LLM completion resets the streak. `remainingMs` is what the enforce mode
 * checks before letting a tool call through — a call made inside the window
 * would only burn quota on a request that is about to fail anyway.
 */
export class BackoffTracker {
  private consecutive = 0
  private untilTs = 0
  private readonly baseMs: number
  private readonly factor: number
  private readonly maxMs: number
  private readonly enabled: boolean

  constructor(cfg: { enabled?: boolean; baseMs?: number; factor?: number; maxMs?: number } | undefined) {
    this.enabled = cfg?.enabled !== false
    this.baseMs = Math.max(0, cfg?.baseMs ?? 30_000)
    this.factor = Math.max(1, cfg?.factor ?? 2)
    this.maxMs = Math.max(this.baseMs, cfg?.maxMs ?? 600_000)
  }

  get streak(): number {
    return this.consecutive
  }

  /** Register a 429 observation; returns the new quiet-window length in ms. */
  onRateLimited(now: number): number {
    this.consecutive++
    const window = Math.min(this.maxMs, this.baseMs * Math.pow(this.factor, this.consecutive - 1))
    this.untilTs = Math.max(this.untilTs, now + window)
    return window
  }

  /** Register a successful LLM completion — resets the streak. */
  onSuccess(): void {
    this.consecutive = 0
    this.untilTs = 0
  }

  remainingMs(now: number): number {
    if (!this.enabled) return 0
    return Math.max(0, this.untilTs - now)
  }
}
