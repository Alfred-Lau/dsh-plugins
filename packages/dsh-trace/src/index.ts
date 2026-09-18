import { LangfuseBackend } from './export/langfuse.js'
import { OtlpBackend } from './export/otlp.js'
import { projectSessionEvent } from './event-map.js'
import { Pipeline } from './pipeline.js'
import { Config } from './config-schema.js'
import type { Context } from '@deepseek-ai/cordis'
import type { TraceBackend } from './pipeline.js'
import type { TraceConfig } from './types.js'

export { Config } from './config-schema.js'

/** Plugin display name (diagnostics only). */
export const name = 'dsh-trace'

/**
 * No required services: the plugin only consumes the `session/event` broadcast
 * and never touches `ctx.tools` / `ctx.llm` / `ctx.sessions`.
 */
export const inject: string[] = []

/**
 * dsh-trace — turns the harness `session/event` stream into OTLP traces and
 * Langfuse observations.
 *
 * Off by default: `enabled: true` plus at least one configured backend is the
 * explicit opt-in. Sanitization runs before anything is queued or sent.
 */
export function apply(ctx: Context, config: TraceConfig): void {
  if (!config?.enabled) {
    ctx.logger.info('[dsh-trace] disabled (off by default). Set enabled: true and configure a backend to opt in.')
    return
  }

  const backends: TraceBackend[] = []
  if (config.otlp?.endpoint) {
    backends.push(new OtlpBackend(config.otlp, { logger: ctx.logger, retry: config.retry, maxQueueRecords: config.batch?.maxQueueRecords }))
  }
  if (config.langfuse?.publicKey && config.langfuse?.secretKey) {
    backends.push(new LangfuseBackend(config.langfuse, { logger: ctx.logger, retry: config.retry, maxQueueRecords: config.batch?.maxQueueRecords }))
  }
  if (backends.length === 0) {
    ctx.logger.warn('[dsh-trace] enabled=true but no backend configured (otlp/langfuse); nothing will be exported.')
    return
  }

  const pipeline = new Pipeline({ backends, config, logger: ctx.logger })
  pipeline.start()

  ctx.on('session/event', (raw) => {
    const projection = projectSessionEvent(raw)
    if (projection) pipeline.enqueue(projection)
  })

  // Best-effort flush kicks from the harness; never block the caller.
  ctx.on('session/flush', () => {
    void pipeline.flushAndClose('session/flush')
  })
  ctx.on('session/disposed', () => {
    void pipeline.flushAndClose('session/disposed')
  })

  ctx.logger.info(`[dsh-trace] exporting to: ${backends.map((b) => b.name).join(', ')}`)
}
