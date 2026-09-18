import { randomUUID } from 'node:crypto'
import type { LangfuseConfig, Span } from '../types.js'
import type { LoggerService } from '@deepseek-ai/cordis'
import type { TraceBackend, BackendOpts } from '../pipeline.js'

/**
 * Langfuse native exporter over the public Ingestion API
 * (`POST {baseUrl}/api/public/ingestion`, Basic auth with public/secret key).
 *
 * Uses the v3 envelope format `{ id, type, timestamp, body }` with snake_case
 * body fields (span-create / generation-create / trace-create), matching the
 * current Langfuse SDKs.
 *
 * Mapping:
 *   turn span        -> trace-create (with session_id grouping)
 *   step / tool span -> span-create
 *   llm span         -> generation-create (model, input, output, usage)
 */

type IngestionEventType = 'trace-create' | 'span-create' | 'generation-create'

interface IngestionEnvelope {
  id: string
  type: IngestionEventType
  timestamp: string
  body: Record<string, unknown>
}

const iso = (ms: number): string => new Date(ms).toISOString()

function baseBody(span: Span): Record<string, unknown> {
  return {
    id: span.kind === 'turn' ? span.traceId : span.spanId,
    name: span.name,
    start_time: iso(span.startTime),
    end_time: iso(span.endTime),
    level: span.status === 'error' ? 'ERROR' : 'DEFAULT',
    status_message: span.errorMessage,
    metadata: {
      dsh_kind: span.kind,
      dsh_session_id: span.sessionId,
      ...span.attributes,
    },
  }
}

export function buildLangfuseBatch(spans: Span[], cfg: LangfuseConfig): IngestionEnvelope[] {
  const events: IngestionEnvelope[] = []

  for (const span of spans) {
    const ts = iso(span.endTime)
    if (span.kind === 'turn') {
      events.push({
        id: randomUUID(),
        type: 'trace-create',
        timestamp: ts,
        body: {
          id: span.traceId,
          timestamp: iso(span.startTime),
          name: span.name,
          session_id: span.sessionId,
          release: cfg.release || undefined,
          tags: cfg.tags?.length ? [...cfg.tags] : undefined,
          metadata: {
            dsh_kind: span.kind,
            dsh_turn: span.turn,
            ...span.attributes,
          },
        },
      })
      continue
    }
    const body = {
      ...baseBody(span),
      trace_id: span.traceId,
      parent_observation_id: span.parentSpanId,
    }
    if (span.kind === 'llm') {
      const gen: Record<string, unknown> = { ...body }
      const model = span.attributes['gen_ai.request.model']
      if (typeof model === 'string') gen.model = model
      const input = span.attributes['dsh.trace.prompt']
      const output = span.attributes['dsh.trace.completion']
      if (typeof input === 'string') gen.input = input
      if (typeof output === 'string') gen.output = output
      const inTok = span.attributes['gen_ai.usage.input_tokens']
      const outTok = span.attributes['gen_ai.usage.output_tokens']
      if (typeof inTok === 'number' || typeof outTok === 'number') {
        gen.usage = {
          input: typeof inTok === 'number' ? inTok : undefined,
          output: typeof outTok === 'number' ? outTok : undefined,
          unit: 'TOKENS',
        }
      }
      events.push({ id: randomUUID(), type: 'generation-create', timestamp: ts, body: gen })
      continue
    }
    events.push({ id: randomUUID(), type: 'span-create', timestamp: ts, body })
  }

  // traces first so every observation lands on an existing trace in one batch
  return events.sort((a, b) => (a.type === 'trace-create' ? -1 : 0) - (b.type === 'trace-create' ? -1 : 0))
}

export class LangfuseBackend implements TraceBackend {
  readonly name = 'langfuse'
  private readonly queue: Span[] = []
  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly factor: number
  private readonly maxDelayMs: number
  private readonly auth: string

  constructor(
    private readonly cfg: LangfuseConfig,
    private readonly opts: BackendOpts,
  ) {
    this.maxAttempts = Math.max(1, opts.retry?.maxAttempts ?? 5)
    this.baseDelayMs = opts.retry?.baseDelayMs ?? 1_000
    this.factor = opts.retry?.factor ?? 2
    this.maxDelayMs = opts.retry?.maxDelayMs ?? 60_000
    this.auth = `Basic ${Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64')}`
  }

  push(span: Span): void {
    const bound = this.opts.maxQueueRecords ?? 2_000
    if (this.queue.length >= bound) {
      this.opts.logger.warn(`[dsh-trace/langfuse] queue bound (${bound}) reached; dropping span`)
      return
    }
    this.queue.push(span)
  }

  async flush(reason: string): Promise<void> {
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0, this.queue.length)
    const body = {
      metadata: { batch_id: `dsh-trace-${Date.now()}` },
      batch: buildLangfuseBatch(batch, this.cfg),
    }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.send(body)
        return
      } catch (err) {
        if (attempt >= this.maxAttempts) {
          this.opts.logger.warn(
            `[dsh-trace/langfuse] dropped ${batch.length} span(s) after ${this.maxAttempts} attempts (${reason}): ${(err as Error).message}`,
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
    const base = (this.cfg.baseUrl ?? 'https://cloud.langfuse.com').replace(/\/$/, '')
    const res = await fetch(`${base}/api/public/ingestion`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: this.auth,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
    })
    if (!res.ok) {
      throw new Error(`Langfuse ingestion failed: HTTP ${res.status}`)
    }
    await res.arrayBuffer().catch(() => undefined)
  }
}
