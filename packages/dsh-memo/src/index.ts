import { compileGlob, attachMemo } from './adapter.js'
import { MemoStore } from './store.js'
import { AuditLogger } from './audit.js'
import { Config } from './config-schema.js'
import { makeTicketScope } from './ticket-scope.js'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoConfig } from './types.js'

export { Config }
export { makeTicketScope, resolveTicketScope, bucketFor } from './ticket-scope.js'
export type { TicketScope, TicketMemoConfig, MemoIsolation } from './ticket-scope.js'

/** Plugin display name (diagnostics only). */
export const name = 'dsh-memo'

/**
 * No required services: the plugin only consumes tool-pipeline channels.
 */
export const inject: string[] = []

/**
 * dsh-tool-memo — memoizes idempotent tool results so repeated identical
 * calls short-circuit instead of re-executing. Off by default.
 */
export function apply(ctx: Context, config: MemoConfig): void {
  if (!config?.enabled) {
    ctx.logger.info('[dsh-tool-memo] disabled (off by default). Set enabled: true to opt in.')
    return
  }

  const store = new MemoStore(config, compileGlob)
  const audit = new AuditLogger(config.audit)

  const ticketScope = makeTicketScope(ctx, config.ticket)
  attachMemo(ctx, { config, store, audit, logger: ctx.logger, ...(ticketScope ? { ticketScope } : {}) })

  ctx.logger.info(
    `[dsh-tool-memo] active: mode=${config.mode ?? 'hint'}, ttl=${config.defaultTtlMs ?? 600_000}ms, maxEntries=${config.maxEntries ?? 256}, audit=${audit.path ?? 'off'}`,
  )
}
