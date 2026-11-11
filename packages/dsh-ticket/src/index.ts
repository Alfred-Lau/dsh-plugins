/**
 * Ticket scope — resolves which dsh-superagent ticket the current Session is
 * acting for, and what that ticket is allowed to do.
 *
 * The pure helpers (`scopeOf`, `policyFor`, `matchGlob`, `sessionIdOf`) are
 * exported directly so a plugin can use them without loading this plugin at
 * all. Installing the plugin additionally registers a `ticket` Cordis service,
 * which is what the other governance packages inject when they want the
 * configured `masterId` / rule table instead of their own copy.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config-schema.js'
import {
  policyFor as resolvePolicy,
  scopeOf as resolveScope,
  sessionIdOf,
  type ResolvedTicketPolicy,
  type ScopeOptions,
  type TicketConfig,
  type TicketRule,
  type TicketScope,
} from './scope.js'

export { Config }
export {
  DEFAULT_WORKER_PREFIX,
  matchGlob,
  policyFor,
  scopeOf,
  sessionIdOf,
} from './scope.js'
export type { ResolvedTicketPolicy, ScopeOptions, TicketConfig, TicketRule, TicketRole, TicketScope } from './scope.js'

/** Plugin display name (diagnostics only). */
export const name = 'dsh-ticket'

/**
 * No required services: the plugin only reads configuration and publishes the
 * `ticket` service. Governance plugins inject `ticket` and degrade gracefully
 * to the exported pure helpers when this plugin is absent.
 */
export const inject: string[] = []

/** Shape of the `ctx.ticket` service. */
export interface TicketService {
  /** Configured router Session id (empty string when unknown). */
  readonly masterId: string
  /** Session-id prefix used for worker sessions. */
  readonly workerPrefix: string
  /** Ordered per-ticket rules, as configured. */
  readonly rules: readonly TicketRule[]
  /** Ticket scope for a Session id, or `undefined` outside Super-agent. */
  scopeOf(sessionId: unknown): TicketScope | undefined
  /** Ticket scope read straight off an event/tool payload. */
  scopeFrom(payload: unknown): TicketScope | undefined
  /** First matching rule for a ticket id. */
  policyFor(ticketId: string): ResolvedTicketPolicy | undefined
}

interface ProvideCapable {
  provide?: (name: string, value: unknown) => unknown
  set?: (name: string, value: unknown) => unknown
}

/**
 * Publishes the service through whichever Cordis seam is available.
 *
 * `provide` is the documented API; `set` is the lower-level write used when a
 * build exposes only the reflection layer. Both are optional on the public
 * `Context` type, so the lookup is explicit rather than assumed.
 */
function publish(ctx: Context, service: TicketService): boolean {
  const seams = ctx as unknown as ProvideCapable
  for (const seam of [seams.provide, seams.set]) {
    if (typeof seam !== 'function') continue
    try {
      seam.call(ctx, 'ticket', service)
      return true
    } catch {
      // Fall through to the next seam.
    }
  }
  return false
}

/**
 * dsh-ticket-context — the join between dsh-superagent and the governance
 * plugins.
 *
 * On by default: it only reads Session ids and config, so it is safe to load
 * in every profile. Outside Super-agent no scope ever resolves and the service
 * is inert.
 */
export function apply(ctx: Context, config: TicketConfig): void {
  const options: ScopeOptions = {
    masterId: config?.masterId || undefined,
    workerPrefix: config?.workerPrefix,
  }
  const rules = config?.rules ?? []

  const service: TicketService = {
    masterId: options.masterId ?? '',
    workerPrefix: options.workerPrefix ?? 'worker-',
    rules,
    scopeOf: sessionId => resolveScope(sessionId, options),
    scopeFrom: payload => resolveScope(sessionIdOf(payload), options),
    policyFor: ticketId => resolvePolicy(ticketId, rules),
  }

  if (config?.enabled === false) {
    ctx.logger.info('[dsh-ticket] disabled; pure helpers still exported.')
    return
  }

  if (!publish(ctx, service)) {
    ctx.logger.warn(
      '[dsh-ticket] no service seam on this Cordis build; ' +
        'governance plugins must import the pure helpers instead of injecting `ticket`.',
    )
    return
  }

  ctx.logger.info(
    `[dsh-ticket] active: prefix=${service.workerPrefix}, ` +
      `masterId=${service.masterId || '(unset, router undetectable)'}, rules=${rules.length}`,
  )
}
