import { BackoffTracker } from './backoff.js'
import { UsageMeter } from './meter.js'
import { attachRateShield } from './adapter.js'
import { AuditLogger } from './audit.js'
import { Config } from './config-schema.js'
import type { Context } from '@deepseek-ai/cordis'
import type { RateConfig } from './types.js'

export { Config }

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

  attachRateShield(ctx, { config, meter, backoff, audit, logger: ctx.logger })

  const parts = [
    `mode=${config.mode ?? 'monitor'}`,
    `backoff=${config.backoff?.enabled === false ? 'off' : `base ${config.backoff?.baseMs ?? 30_000}ms`}`,
    `budget=${(config.budget?.dailyTokens ?? 0) > 0 ? config.budget?.dailyTokens : 'off'}`,
    `storm=${(config.toolStorm?.maxCalls ?? 0) > 0 ? `${config.toolStorm?.maxCalls}/${Math.round((config.toolStorm?.windowMs ?? 60_000) / 1000)}s` : 'off'}`,
  ]
  ctx.logger.info(`[dsh-rate-shield] active: ${parts.join(', ')}, audit=${audit.path ?? 'off'}`)
}
