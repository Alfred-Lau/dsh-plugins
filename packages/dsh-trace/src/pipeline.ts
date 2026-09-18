import { SpanCollector } from './collector.js'
import { createSanitizer } from './sanitize.js'
import type { LoggerService } from '@deepseek-ai/cordis'
import type { SessionEventProjection, Span, TraceConfig } from './types.js'

export interface TraceBackend {
  readonly name: string
  push(span: Span): void
  flush(reason: string): Promise<void>
  dispose(): Promise<void>
}

export interface BackendOpts {
  logger: LoggerService
  retry?: TraceConfig['retry']
  maxQueueRecords?: number
}

export interface PipelineOptions {
  backends: TraceBackend[]
  config: TraceConfig
  logger: LoggerService
}

/**
 * Event pipeline: projection -> collector (spans, sanitized) -> fan-out to
 * every configured backend. Each backend owns its queue and retry policy;
 * a failing backend can never break the harness hot path (failures warn,
 * count and drop — the WAL-backed durable outbox is planned for v0.2).
 */
export class Pipeline {
  private readonly collector: SpanCollector
  private readonly backends: TraceBackend[]
  private readonly logger: LoggerService
  private readonly flushIntervalMs: number
  private timer: NodeJS.Timeout | undefined
  private stopped = false

  constructor(opts: PipelineOptions) {
    this.backends = opts.backends
    this.logger = opts.logger
    this.flushIntervalMs = opts.config.batch?.flushIntervalMs ?? 5_000
    const sanitizer = createSanitizer(opts.config.sanitize)
    this.collector = new SpanCollector({
      config: opts.config,
      sanitizer,
      onSpan: (span) => this.dispatch(span),
    })
  }

  /** Feed a projected session event into the span collector. */
  enqueue(p: SessionEventProjection): void {
    try {
      this.collector.feed(p)
    } catch (err) {
      // Observability must never break the harness hot path.
      this.logger.debug(`[dsh-trace] collector error: ${(err as Error).message}`)
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.flushAll('timer')
    }, this.flushIntervalMs)
    // Do not keep the process alive just for flush timers.
    this.timer.unref?.()
  }

  async flushAll(reason: string): Promise<void> {
    if (this.stopped) return
    await Promise.all(this.backends.map((b) => b.flush(reason).catch(() => undefined)))
  }

  /** Close dangling spans and flush once (used on session/flush / disposed). */
  async flushAndClose(reason: string, sessionId?: string): Promise<void> {
    this.collector.closeAll(sessionId)
    await this.flushAll(reason)
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.stopped = true
    await Promise.all(this.backends.map((b) => b.dispose().catch(() => undefined)))
  }

  private dispatch(span: Span): void {
    for (const backend of this.backends) {
      try {
        backend.push(span)
      } catch (err) {
        this.logger.debug(`[dsh-trace] push to ${backend.name} failed: ${(err as Error).message}`)
      }
    }
  }
}
