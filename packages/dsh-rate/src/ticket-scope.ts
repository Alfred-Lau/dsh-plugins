/**
 * Ticket scoping for dsh-rate-shield.
 *
 * A Super-agent ticket is identified by the `worker-<ticketId>` Session naming
 * dsh-superagent already uses. Keeping the derivation here (instead of
 * importing dsh-ticket-context) keeps this package installable on its own; the
 * shared `ticket` service is preferred when it happens to be loaded.
 */

export interface TicketScope {
  role: 'router' | 'worker'
  sessionId: string
  ticketId?: string
}

export interface TicketRateRule {
  /** Glob matched against the ticket id (`*`, `?`, and `**` are supported). */
  match: string
  /** Token allowance for this ticket per UTC day; 0 disables. */
  dailyTokens?: number
  /** Tool calls allowed per window for this ticket; 0 disables. */
  maxCalls?: number
  /** Override the global mode for this ticket. */
  mode?: 'monitor' | 'enforce'
}

export interface TicketRateConfig {
  /** Default true: bucket by ticket whenever one resolves. */
  enabled?: boolean
  /** Router Session id; without it only worker Sessions resolve a ticket. */
  masterId?: string
  /** Worker Session-id prefix (dsh-superagent uses `worker-`). */
  workerPrefix?: string
  /** Per-ticket limits, first glob match wins. */
  rules?: TicketRateRule[]
}

export const DEFAULT_WORKER_PREFIX = 'worker-'

/** Resolves the ticket a Session is acting for, if any. */
export function resolveTicketScope(
  sessionId: unknown,
  options: { masterId?: string; workerPrefix?: string } = {},
): TicketScope | undefined {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const prefix = options.workerPrefix ?? DEFAULT_WORKER_PREFIX
  if (prefix && sessionId.startsWith(prefix)) {
    const ticketId = sessionId.slice(prefix.length)
    if (ticketId.length === 0) return undefined
    return { role: 'worker', sessionId, ticketId }
  }
  if (options.masterId && sessionId === options.masterId) {
    return { role: 'router', sessionId }
  }
  return undefined
}

/** First matching rule for a ticket; router matches on the literal `router`. */
export function ruleForTicket<T extends { match: string }>(
  rules: readonly T[] | undefined,
  scope: TicketScope | undefined,
): T | undefined {
  if (!rules || rules.length === 0 || !scope) return undefined
  const subject = scope.role === 'router' ? 'router' : scope.ticketId ?? ''
  for (const rule of rules) {
    if (globMatch(rule.match, subject)) return rule
  }
  return undefined
}

/** `*` and `?` stay within one path segment, `**` crosses them. */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true
  if (!pattern.includes('*') && !pattern.includes('?')) return false
  let re = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] ?? ''
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i += 1
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  try {
    return new RegExp(`^${re}$`, 'i').test(value)
  } catch {
    return false
  }
}

/** The bucket key for a scope: the ticket id, `router`, or undefined. */
export function bucketOf(scope: TicketScope | undefined): string | undefined {
  if (!scope) return undefined
  return scope.role === 'router' ? 'router' : scope.ticketId
}

export interface TicketScopeHandle {
  scopeOf(sessionId: unknown): TicketScope | undefined
  ruleFor(scope: TicketScope | undefined): TicketRateRule | undefined
  /** `service` when the shared dsh-ticket-context service supplied the rules. */
  source: 'service' | 'config'
}

/**
 * Builds the resolver used by the adapter. Prefers the `ticket` service from
 * dsh-ticket-context (so one rule table governs every package) and falls back
 * to this plugin's own `ticket.rules`.
 */
export function makeTicketScope(
  ctx: { get?(name: string): unknown },
  config: TicketRateConfig | undefined,
): TicketScopeHandle | undefined {
  if (config?.enabled === false) return undefined
  const options = { masterId: config?.masterId ?? '', workerPrefix: config?.workerPrefix ?? DEFAULT_WORKER_PREFIX }

  const service = typeof ctx.get === 'function' ? (ctx.get('ticket') as Record<string, unknown> | undefined) : undefined
  const serviceScopeOf = service && typeof service.scopeOf === 'function' ? (service.scopeOf as (s: unknown) => TicketScope | undefined) : undefined
  const serviceRules = Array.isArray(service?.rules) ? (service.rules as TicketRateRule[]) : undefined

  const ownRules = config?.rules ?? []
  const rules = serviceRules ?? ownRules
  const scopeOf = (sessionId: unknown): TicketScope | undefined => {
    if (serviceScopeOf) {
      const viaService = serviceScopeOf(sessionId)
      if (viaService) return viaService
    }
    return resolveTicketScope(sessionId, options)
  }

  return {
    scopeOf,
    ruleFor: (scope) => ruleForTicket(rules, scope),
    source: serviceRules ? 'service' : 'config',
  }
}
