import { BackoffTracker } from './backoff.js'
import { UsageMeter } from './meter.js'
import { attachRateShield } from './adapter.js'
import { AuditLogger } from './audit.js'
import { Config } from './config-schema.js'
import { makeTicketScope } from './ticket-scope.js'
import type { Context } from '@deepseek-ai/cordis'
import type { RateConfig } from './types.js'

export { Config }
export { makeTicketScope, resolveTicketScope, ruleForTicket, globMatch, bucketOf } from './ticket-scope.js'
export type { TicketScope, TicketRateRule, TicketRateConfig } from './ticket-scope.js'

/** Plugin display name (diagnostics only). */
export const name = 'dsh-rate'

/**
 * No required services.
 */
export const inject: string[] = []

/**
 * dsh-rate-shield — 429 backoff windows, daily token budgets and tool-call
 * storm control for DeepSeek Harness. Monitors by default; enforce mode is
 * the explicit opt-in that denies tool calls.
 */
export function apply(ctx: Context, config: RateConfig): void {
  if (!config?.enabled) {
    ctx.logger.info('[dsh-rate-shield] disabled (off by default). Set enabled: true to opt in.')
    return
  }

  const meter = new UsageMeter()
  const backoff = new BackoffTracker(config.backoff)
  const audit = new AuditLogger(config.audit)

  const ticketScope = makeTicketScope(ctx, config.ticket)
  attachRateShield(ctx, { config, meter, backoff, audit, logger: ctx.logger, ...(ticketScope ? { ticketScope } : {}) })

  const parts = [
    `mode=${config.mode ?? 'monitor'}`,
    `backoff=${config.backoff?.enabled === false ? 'off' : `base ${config.backoff?.baseMs ?? 30_000}ms`}`,
    `budget=${(config.budget?.dailyTokens ?? 0) > 0 ? config.budget?.dailyTokens : 'off'}`,
    `storm=${(config.toolStorm?.maxCalls ?? 0) > 0 ? `${config.toolStorm?.maxCalls}/${Math.round((config.toolStorm?.windowMs ?? 60_000) / 1000)}s` : 'off'}`,
    `ticket=${ticketScope ? `${config.ticket?.rules?.length ?? 0} rule(s) from ${ticketScope.source}` : 'off'}`,
  ]
  ctx.logger.info(`[dsh-rate-shield] active: ${parts.join(', ')}, audit=${audit.path ?? 'off'}`)
}
