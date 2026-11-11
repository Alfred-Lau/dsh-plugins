import { compileDetectors, PiiDetector } from './detector.js'
import { attachPiiGate } from './adapter.js'
import { AuditLogger } from './audit.js'
import { Config } from './config-schema.js'
import { makeTicketScope } from './ticket-scope.js'
import type { Context } from '@deepseek-ai/cordis'
import type { PiiConfig } from './types.js'

export { Config }
export { makeTicketScope, resolveTicketScope, ruleForTicket } from './ticket-scope.js'
export type { TicketScope, TicketPiiRule, TicketPiiConfig } from './ticket-scope.js'

/** Plugin display name (diagnostics only). */
export const name = 'dsh-pii'

/**
 * No required services: the plugin only consumes tool-pipeline channels.
 */
export const inject: string[] = []

/**
 * dsh-pii-gate — scans tool arguments (and results) for personally
 * identifiable information. Off by default; `mode: 'audit'` observes, `mode:
 * 'block'` denies outbound tools carrying PII.
 */
export function apply(ctx: Context, config: PiiConfig): void {
  if (!config?.enabled) {
    ctx.logger.info('[dsh-pii-gate] disabled (off by default). Set enabled: true to opt in.')
    return
  }

  const detectors = compileDetectors({ ...config, logger: ctx.logger })
  if (detectors.length === 0) {
    ctx.logger.warn('[dsh-pii-gate] enabled but every detector is off; nothing will be scanned.')
    return
  }

  const detector = new PiiDetector(detectors, config.maxScanChars)
  const audit = new AuditLogger(config.audit)

  const ticketScope = makeTicketScope(ctx, config.ticket)
  attachPiiGate(ctx, { config, detector, audit, logger: ctx.logger, ...(ticketScope ? { ticketScope } : {}) })

  ctx.logger.info(
    `[dsh-pii-gate] active: mode=${config.mode ?? 'audit'}, detectors=${detectors.map((d) => d.id).join(',')}, ` +
      `audit=${audit.path ?? 'off'}` +
      (ticketScope ? `, ticket rules=${config.ticket?.rules?.length ?? 0} from ${ticketScope.source}` : ', ticket off'),
  )
}
