import { SCOPE_NAME, SCOPE_VERSION } from '../semconv.js'
import type { OtlpConfig } from '../types.js'
import type { Span } from '../types.js'
import type { LoggerService } from '@deepseek-ai/cordis'
import type { TraceBackend, BackendOpts } from '../pipeline.js'

type OtlpAttrValue = { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean }

interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: { key: string; value: OtlpAttrValue }[]
  status: { code: number; message?: string }
}

function attr(key: string, value: string | number | boolean): { key: string; value: OtlpAttrValue } {
  if (typeof value === 'string') return { key, value: { stringValue: value } }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  // OTLP JSON encodes int64 values as strings.
  return Number.isInteger(value)
    ? { key, value: { intValue: String(value) } }
    : { key, value: { doubleValue: value } }
}

function toOtlpSpan(span: Span): OtlpSpan {
  const otlp: OtlpSpan = {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: String(span.startTime * 1_000_000),
    endTimeUnixNano: String(span.endTime * 1_000_000),
    attributes: Object.entries(span.attributes).map(([k, v]) => attr(k, v)),
    status: span.status === 'error' ? { code: 2, message: span.errorMessage } : { code: 1 },
  }
  if (span.parentSpanId) otlp.parentSpanId = span.parentSpanId
  return otlp
}

export function buildTracesPayload(
  spans: Span[],
  resource: { serviceName: string; serviceVersion?: string },
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr('service.name', resource.serviceName),
            ...(resource.serviceVersion ? [attr('service.version', resource.serviceVersion)] : []),
          ],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
            spans: spans.map(toOtlpSpan),
          },
        ],
      },
    ],
  }
}

/** Exports traces via OTLP/HTTP with JSON encoding (`{endpoint}/v1/traces`). */
export class OtlpBackend implements TraceBackend {
  readonly name = 'otlp'
  private readonly queue: Span[] = []
  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly factor: number
  private readonly maxDelayMs: number

  constructor(
    private readonly cfg: OtlpConfig,
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
      this.opts.logger.warn(`[dsh-trace/otlp] queue bound (${bound}) reached; dropping span`)
      return
    }
    this.queue.push(span)
  }

  async flush(reason: string): Promise<void> {
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0, this.queue.length)
    const payload = buildTracesPayload(batch, {
      serviceName: this.cfg.serviceName ?? 'deepseek-harness',
      serviceVersion: this.cfg.serviceVersion || undefined,
    })
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.send(payload)
        return
      } catch (err) {
        if (attempt >= this.maxAttempts) {
          this.opts.logger.warn(
            `[dsh-trace/otlp] dropped ${batch.length} span(s) after ${this.maxAttempts} attempts (${reason}): ${(err as Error).message}`,
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

  private async send(payload: Record<string, unknown>): Promise<void> {
    const url = `${this.cfg.endpoint.replace(/\/$/, '')}/v1/traces`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cfg.headers ?? {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
    })
    if (!res.ok) {
      throw new Error(`OTLP export failed: HTTP ${res.status}`)
    }
    // Drain the body so the socket is released even on large responses.
    await res.arrayBuffer().catch(() => undefined)
  }
}
