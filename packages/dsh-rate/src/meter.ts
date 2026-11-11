/**
 * Rolling-window meter for LLM traffic and daily token budget.
 *
 * The meter consumes the harness `session/event` broadcast (same source as
 * dsh-trace, projected defensively) and keeps:
 *   - a timestamp list of observed 429s / LLM completions,
 *   - a per-UTC-day token total (input + output),
 *   - a rolling window of tool-call timestamps (storm control).
 *
 * Every counter is bucketed: `global` holds the whole process, and each
 * dsh-superagent ticket gets its own bucket so one runaway ticket cannot spend
 * another ticket's allowance or trip its storm window.
 */
export class UsageMeter {
  /** `${dayKey}\u0000${bucket}` -> tokens */
  private tokensByDay = new Map<string, number>()
  /** bucket -> tool-call timestamps */
  private toolCalls = new Map<string, number[]>()
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

  addTokens(n: number, now: Date, bucket = 'global'): number {
    const key = dayKeyOf(now)
    if (key !== this.todayKey) {
      this.todayKey = key
      // Keep the map small: anything older than today is irrelevant.
      for (const k of [...this.tokensByDay.keys()]) {
        if (!k.startsWith(key)) this.tokensByDay.delete(k)
      }
    }
    const mapKey = `${key}\u0000${bucket}`
    const next = (this.tokensByDay.get(mapKey) ?? 0) + n
    this.tokensByDay.set(mapKey, next)
    return next
  }

  tokensToday(now: Date, bucket = 'global'): number {
    return this.tokensByDay.get(`${dayKeyOf(now)}\u0000${bucket}`) ?? 0
  }

  recordToolCall(now: number, windowMs: number, bucket = 'global'): number {
    const floor = now - windowMs
    const kept = (this.toolCalls.get(bucket) ?? []).filter((ts) => ts >= floor)
    kept.push(now)
    this.toolCalls.set(bucket, kept)
    return kept.length
  }

  reset(bucket?: string): void {
    if (bucket === undefined) this.toolCalls.clear()
    else this.toolCalls.delete(bucket)
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
