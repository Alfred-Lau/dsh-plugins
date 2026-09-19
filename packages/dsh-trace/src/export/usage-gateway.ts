import { ATTR } from '../semconv.js'
import type { HttpUsageConfig } from '../types.js'
import type { Span } from '../types.js'
import type { LoggerService } from '@deepseek-ai/cordis'
import type { TraceBackend, BackendOpts } from '../pipeline.js'

/**
 * OpenMeter-compatible CloudEvent envelope (specversion 1.0). Gateways that
 * speak the CloudEvents JSON binding can consume these events directly;
 * generic JSON gateways can treat each event as an opaque row.
 */
export interface UsageCloudEvent {
  specversion: '1.0'
  id: string
  type: string
  source: string
  subject: string
  time: string
  data: {
    sessionId: string
    spanId: string
    model?: string
    status: 'ok' | 'error'
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    reasoningTokens?: number
    totalTokens: number
  }
}

function num(span: Span, key: string): number | undefined {
  const v = span.attributes[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Projects LLM spans into CloudEvents usage records. Non-LLM spans are
 * skipped; token buckets are read from gen_ai.usage.* span attributes and
 * default to 0 when a failed call never reported usage.
 */
export function buildUsageEvents(spans: Span[], cfg: HttpUsageConfig): UsageCloudEvent[] {
  const type = cfg.eventType ?? 'com.dsh.llm.usage'
  const source = cfg.eventSource ?? 'deepseek-harness'
  const events: UsageCloudEvent[] = []
  for (const span of spans) {
    if (span.kind !== 'llm') continue
    const input = num(span, ATTR.usageInput) ?? 0
    const output = num(span, ATTR.usageOutput) ?? 0
    const cacheRead = num(span, ATTR.usageCacheRead)
    const reasoning = num(span, ATTR.usageReasoning)
    const data: UsageCloudEvent['data'] = {
      sessionId: span.sessionId,
      spanId: span.spanId,
      status: span.status,
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + output,
    }
    const model = span.attributes[ATTR.requestModel]
    if (typeof model === 'string' && model) data.model = model
    if (cacheRead !== undefined) data.cacheReadTokens = cacheRead
    if (reasoning !== undefined) data.reasoningTokens = reasoning
    events.push({
      specversion: '1.0',
      id: span.spanId,
      type,
      source,
      subject: span.sessionId,
      time: new Date(span.endTime).toISOString(),
      data,
    })
  }
  return events
}

/** Posts span/usage batches as JSON to a generic HTTP gateway. */
export class HttpUsageBackend implements TraceBackend {
  readonly name = 'http-usage'
  private readonly queue: Span[] = []
  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly factor: number
  private readonly maxDelayMs: number

  constructor(
    private readonly cfg: HttpUsageConfig,
    private readonly opts: BackendOpts,
  ) {
    this.maxAttempts = Math.max(1, opts.retry?.maxAttempts ?? 5)
    this.baseDelayMs = opts.retry?.baseDelayMs ?? 1_000
    this.factor = opts.retry?.factor ?? 2
    this.maxDelayMs = opts.retry?.maxDelayMs ?? 60_000
  }

  push(span: Span): void {
    const bound = this.opts.maxQueueRecords ?? 2_000
    if (this.queue.length >= bound) {
      this.opts.logger.warn(`[dsh-trace/http-usage] queue bound (${bound}) reached; dropping span`)
      return
    }
    this.queue.push(span)
  }

  async flush(reason: string): Promise<void> {
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0, this.queue.length)
    // Usage mode filters to LLM spans at flush time; a batch with no LLM
    // spans has nothing to report and is dropped without a request.
    const body: unknown =
      (this.cfg.mode ?? 'spans') === 'usage'
        ? buildUsageEvents(batch, this.cfg)
        : batch
    if (Array.isArray(body) && body.length === 0) return
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.send(body)
        return
      } catch (err) {
        if (attempt >= this.maxAttempts) {
          const dropped = Array.isArray(body) ? body.length : batch.length
          this.opts.logger.warn(
            `[dsh-trace/http-usage] dropped ${dropped} record(s) after ${this.maxAttempts} attempts (${reason}): ${(err as Error).message}`,
          )
          return
        }
        const wait = Math.min(this.baseDelayMs * this.factor ** (attempt - 1), this.maxDelayMs)
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  }

  async dispose(): Promise<void> {
    await this.flush('dispose')
  }

  private async send(body: unknown): Promise<void> {
    const res = await fetch(this.cfg.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cfg.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
    })
    if (!res.ok) {
      throw new Error(`gateway export failed: HTTP ${res.status}`)
    }
    // Drain the body so the socket is released even on large responses.
    await res.arrayBuffer().catch(() => undefined)
  }
}
