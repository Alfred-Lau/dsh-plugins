/**
 * Ticket scope for dsh-superagent Sessions.
 *
 * Kept as a local copy (rather than a hard dependency on `dsh-ticket-context`)
 * so this package stays installable on its own. When that plugin *is* loaded,
 * its `ticket` service supplies the scope; otherwise the Session-id convention
 * dsh-superagent already uses (`worker-<ticketId>`) is enough.
 */

export interface TicketScope {
  role: 'router' | 'worker'
  ticketId?: string
}

/** Per-ticket PII policy; the first matching glob wins. */
export interface TicketPiiRule {
  /** Glob over the ticket id, e.g. `review-*` or `*`. */
  match: string
  /** Force a mode for this ticket, overriding the global one. */
  mode?: 'audit' | 'block'
  /** Restrict (or extend) the outbound tool set for this ticket. */
  outboundTools?: string[]
  /** Raise the bar: block at this many matches instead of the global minimum. */
  minMatches?: number
}

export interface TicketPiiConfig {
  /** Tag audit entries with the ticket and apply per-ticket rules. Default true. */
  enabled?: boolean
  /** Router Session id; without it only worker Sessions resolve a ticket. */
  masterId?: string
  /** Worker Session-id prefix (dsh-superagent uses `worker-`). */
  workerPrefix?: string
  /** Per-ticket overrides. */
  rules?: TicketPiiRule[]
}

const DEFAULT_WORKER_PREFIX = 'worker-'

/** Minimal shape of the `dsh-ticket-context` service we consume. */
interface TicketServiceLike {
  scopeOf?: (sessionId: unknown) => TicketScope | undefined
  rules?: unknown
}

export function ticketServiceOf(ctx: unknown): TicketServiceLike | undefined {
  const getter = (ctx as { get?: (name: string) => unknown } | undefined)?.get
  if (typeof getter !== 'function') return undefined
  try {
    const service = getter.call(ctx, 'ticket')
    return typeof service === 'object' && service !== null ? (service as TicketServiceLike) : undefined
  } catch {
    return undefined
  }
}

/** Derives the ticket scope from a Session id, or `undefined` outside Super-agent. */
export function resolveTicketScope(
  sessionId: string | undefined,
  config: { masterId?: string; workerPrefix?: string },
): TicketScope | undefined {
  if (!sessionId) return undefined
  const prefix = config.workerPrefix ?? DEFAULT_WORKER_PREFIX
  if (prefix.length > 0 && sessionId.startsWith(prefix)) {
    const ticketId = sessionId.slice(prefix.length)
    return ticketId.length > 0 ? { role: 'worker', ticketId } : undefined
  }
  if (config.masterId && sessionId === config.masterId) return { role: 'router' }
  return undefined
}

function globToRegExp(glob: string): RegExp {
  let source = ''
  for (const char of glob) {
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** First rule whose glob matches the ticket (the router resolves as `(router)`). */
export function ruleForTicket(scope: TicketScope | undefined, rules: readonly TicketPiiRule[]): TicketPiiRule | undefined {
  if (!scope) return undefined
  const id = scope.role === 'router' ? '(router)' : scope.ticketId
  if (!id) return undefined
  return rules.find(rule => globToRegExp(rule.match).test(id))
}

export interface TicketScopeHandle {
  scopeOf: (sessionId: string | undefined) => TicketScope | undefined
  ruleFor: (scope: TicketScope | undefined) => TicketPiiRule | undefined
  source: string
}

/**
 * Builds the resolver used by the gate: the shared service when present, the
 * local derivation otherwise. Returns `undefined` when the feature is off.
 */
export function makeTicketScope(ctx: unknown, config: TicketPiiConfig | undefined): TicketScopeHandle | undefined {
  if (config?.enabled === false) return undefined
  const service = ticketServiceOf(ctx)
  const rules = config?.rules ?? []

  const scopeOf = service?.scopeOf
    ? (sessionId: string | undefined) => {
        const scope = service.scopeOf!(sessionId)
        return scope ? { role: scope.role, ticketId: scope.ticketId } : undefined
      }
    : (sessionId: string | undefined) => resolveTicketScope(sessionId, config ?? {})

  return {
    scopeOf,
    ruleFor: scope => ruleForTicket(scope, rules),
    source: service?.scopeOf ? 'dsh-ticket-context' : 'config',
  }
}
