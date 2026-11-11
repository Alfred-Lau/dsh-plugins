/**
 * Ticket isolation for dsh-memo.
 *
 * A memo cache shared across dsh-superagent tickets is a data-leak path: ticket
 * A reads `config/secrets.env`, ticket B asks for the same path, and the cache
 * hands it over without touching the tool. Bucketing the cache key by ticket
 * closes that path, and the cost is only a lower hit rate between tickets.
 *
 * The ticket comes from the `worker-<ticketId>` Session naming dsh-superagent
 * already uses. Deriving it here keeps this package installable on its own; the
 * shared `ticket` service is preferred when it happens to be loaded.
 */

export type MemoIsolation = 'ticket' | 'session' | 'none'

export interface TicketMemoConfig {
  /** Default true: isolate the cache per ticket. */
  enabled?: boolean
  /** Router Session id; without it only worker Sessions resolve a ticket. */
  masterId?: string
  /** Worker Session-id prefix (dsh-superagent uses `worker-`). */
  workerPrefix?: string
  /**
   * `ticket`  - one cache per ticket (default; the isolation that matters)
   * `session` - one cache per Session, router included (strictest)
   * `none`    - one shared cache (pre-0.2 behaviour)
   */
  isolation?: MemoIsolation
}

export interface TicketScope {
  role: 'router' | 'worker'
  sessionId: string
  ticketId?: string
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

/**
 * Cache bucket for a Session.
 *
 * Returns `''` (the shared bucket) when isolation is off or the Session is not
 * part of Super-agent — a plain session keeps the pre-0.2 behaviour.
 */
export function bucketFor(
  sessionId: string | undefined,
  config: TicketMemoConfig | undefined,
  scopeOf?: (sessionId: unknown) => TicketScope | undefined,
): string {
  if (config?.enabled === false) return ''
  const isolation = config?.isolation ?? 'ticket'
  if (isolation === 'none') return ''
  const options = { masterId: config?.masterId ?? '', workerPrefix: config?.workerPrefix ?? DEFAULT_WORKER_PREFIX }
  const scope = scopeOf ? scopeOf(sessionId) : resolveTicketScope(sessionId, options)
  if (!scope) return ''
  if (isolation === 'session') return `session:${scope.sessionId}`
  return scope.role === 'router' ? 'ticket:router' : `ticket:${scope.ticketId}`
}

export interface TicketScopeHandle {
  scopeOf(sessionId: unknown): TicketScope | undefined
  bucketOf(sessionId: string | undefined): string
  /** `service` when dsh-ticket-context supplied the scope resolution. */
  source: 'service' | 'config'
}

/** Builds the resolver used by the adapter; prefers the shared `ticket` service. */
export function makeTicketScope(
  ctx: { get?(name: string): unknown },
  config: TicketMemoConfig | undefined,
): TicketScopeHandle | undefined {
  if (config?.enabled === false) return undefined
  const options = { masterId: config?.masterId ?? '', workerPrefix: config?.workerPrefix ?? DEFAULT_WORKER_PREFIX }
  const service = typeof ctx.get === 'function' ? (ctx.get('ticket') as Record<string, unknown> | undefined) : undefined
  const serviceScopeOf =
    service && typeof service.scopeOf === 'function' ? (service.scopeOf as (s: unknown) => TicketScope | undefined) : undefined

  const scopeOf = (sessionId: unknown): TicketScope | undefined => {
    if (serviceScopeOf) {
      const viaService = serviceScopeOf(sessionId)
      if (viaService) return viaService
    }
    return resolveTicketScope(sessionId, options)
  }

  return {
    scopeOf,
    bucketOf: (sessionId) => bucketFor(sessionId, config, scopeOf),
    source: serviceScopeOf ? 'service' : 'config',
  }
}
