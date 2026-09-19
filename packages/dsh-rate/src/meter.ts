/**
 * Rolling-window meter for LLM traffic and daily token budget.
 *
 * The meter consumes the harness `session/event` broadcast (same source as
 * dsh-trace, projected defensively) and keeps:
 *   - a timestamp list of observed 429s / LLM completions,
 *   - a per-UTC-day token total (input + output),
 *   - a rolling window of tool-call timestamps (storm control).
 */
export class UsageMeter {
  private tokensByDay = new Map<string, number>()
  private toolCalls: number[] = []
  private todayKey = ''

  /** Projected from a session/event payload; returns tokens when found. */
  static projectTokens(raw: unknown): { tokens: number; isError: boolean; isRateLimited: boolean; type: string } | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const rec = raw as Record<string, unknown>
    const type = firstString(rec.type, rec.event, rec.kind)
    if (!type) return null
    const t = type.toLowerCase()
    const isLlm =
      t.includes('assistant') || t.includes('llm') || t.includes('model') ||
      t.includes('chat') || t.includes('attempt') || t.includes('completion')
    if (!isLlm) return null
    const errText = firstString(rec.error, rec.err) ?? ''
    const isRateLimited = /429|rate.?limit/i.test(errText) || rec.status === 429
    const usage = firstRecord(rec.usage, rec.tokenUsage, rec.token_usage) ?? rec
    const input = firstNumber(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens)
    const output = firstNumber(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens)
    const tokens = (input ?? 0) + (output ?? 0)
    return { tokens, isError: errText.length > 0, isRateLimited, type }
  }

  addTokens(n: number, now: Date): number {
    const key = dayKeyOf(now)
    if (key !== this.todayKey) this.todayKey = key
    const cur = this.tokensByDay.get(key) ?? 0
    const next = cur + n
    this.tokensByDay.set(key, next)
    // Keep the map small: anything older than yesterday is irrelevant.
    if (this.tokensByDay.size > 3) {
      for (const k of [...this.tokensByDay.keys()]) {
        if (k !== key) this.tokensByDay.delete(k)
      }
    }
    return next
  }

  tokensToday(now: Date): number {
    const key = dayKeyOf(now)
    return this.tokensByDay.get(key) ?? 0
  }

  recordToolCall(now: number, windowMs: number): number {
    const floor = now - windowMs
    this.toolCalls = this.toolCalls.filter((ts) => ts >= floor)
    this.toolCalls.push(now)
    return this.toolCalls.length
  }

  reset(): void {
    this.toolCalls = []
  }
}

function dayKeyOf(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function firstString(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v
  return ''
}

function firstRecord(...vals: unknown[]): Record<string, unknown> | undefined {
  for (const v of vals) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>
  }
  return undefined
}

function firstNumber(...vals: unknown[]): number | undefined {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v
  return undefined
}
