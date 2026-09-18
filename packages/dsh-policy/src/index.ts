import { attachPolicy } from './adapter.js'
import { AuditLogger } from './audit.js'
import { PolicyEvaluator } from './evaluator.js'
import { Config } from './config-schema.js'
import type { Context } from '@deepseek-ai/cordis'
import type { PolicyConfig } from './types.js'

export { Config } from './config-schema.js'
export { PolicyEvaluator } from './evaluator.js'
export { globToRegExp, extractCommands, extractPaths } from './matcher.js'
export type { PolicyConfig, PolicyRule, Decision, Effect } from './types.js'

/** Plugin display name (diagnostics only). */
export const name = 'dsh-policy'

/**
 * No required services: the plugin hooks the tool-execution pipeline events
 * (`tools/pre-execute`, `tools/post-execute`) and never touches other seams.
 */
export const inject: string[] = []

/**
 * dsh-policy — declarative tool-call permission control.
 *
 * Off by default: set `enabled: true` in the config row to opt in. Once on,
 * calls matching no rule fall through to `defaultDecision` (default: ask),
 * and evaluator errors deny the call (fail-closed).
 */
export function apply(ctx: Context, config: PolicyConfig): void {
  if (!config?.enabled) {
    ctx.logger.info('[dsh-policy] disabled (off by default). Set enabled: true to activate permission rules.')
    return
  }

  // Invalid rules/regex throw here on purpose: misconfiguration must fail
  // loud at load time, never silently at runtime.
  const evaluator = new PolicyEvaluator(config)
  const audit = new AuditLogger(config.audit)

  attachPolicy(ctx, evaluator, audit, ctx.logger)

  ctx.logger.info(
    `[dsh-policy] active: ${evaluator.ruleCount} rule(s), default=${config.defaultDecision ?? 'ask'}, ` +
      `failClosed=${config.failClosed !== false}${audit.path ? `, audit=${audit.path}` : ', audit=off'}`,
  )
}
