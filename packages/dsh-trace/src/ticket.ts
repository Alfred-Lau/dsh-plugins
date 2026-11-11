/**
 * Ticket scope resolution for dsh-superagent sessions.
 *
 * Kept local (rather than imported from `dsh-ticket-context`) so `dsh-trace`
 * stays installable on its own. When `dsh-ticket-context` *is* loaded, its
 * `ticket` service wins — it carries the configured `masterId` and rule table.
 * Otherwise this module derives the same answer from the Session id alone.
 */

export interface TicketScope {
  role: 'router' | 'worker'
  ticketId?: string
}

export interface TicketScopeConfig {
  /** Whether to tag spans with the ticket at all. */
  enabled?: boolean
  /** Router Session id; without it only workers resolve. */
  masterId?: string
  /** Worker Session-id prefix used by dsh-superagent. */
  workerPrefix?: string
}

/** Minimal shape of the `dsh-ticket-context` service we consume. */
interface TicketServiceLike {
  scopeOf?: (sessionId: unknown) => { role: 'router' | 'worker'; ticketId?: string } | undefined
}

/**
 * Finds the `ticket` service through Cordis' reflection layer.
 *
 * `ctx.get` is the documented read (`undefined` when nothing provides the
 * name), so a missing `dsh-ticket-context` is a normal case, not an error.
 */
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

const DEFAULT_WORKER_PREFIX = 'worker-'

/** Derives the ticket scope from a Session id, or `undefined` outside Super-agent. */
export function resolveTicketScope(sessionId: string | undefined, config: TicketScopeConfig): TicketScope | undefined {
  if (!sessionId) return undefined
  const prefix = config.workerPrefix ?? DEFAULT_WORKER_PREFIX
  if (prefix.length > 0 && sessionId.startsWith(prefix)) {
    const ticketId = sessionId.slice(prefix.length)
    return ticketId.length > 0 ? { role: 'worker', ticketId } : undefined
  }
  if (config.masterId && sessionId === config.masterId) return { role: 'router' }
  return undefined
}

/**
 * Builds the resolver `apply()` uses: the shared service when present, the
 * local derivation otherwise.
 */
export function makeScopeResolver(
  ctx: unknown,
  config: TicketScopeConfig,
): ((sessionId: string) => TicketScope | undefined) | undefined {
  if (config.enabled === false) return undefined
  const service = ticketServiceOf(ctx)
  if (service?.scopeOf) {
    return sessionId => {
      const scope = service.scopeOf!(sessionId)
      return scope ? { role: scope.role, ticketId: scope.ticketId } : undefined
    }
  }
  return sessionId => resolveTicketScope(sessionId, config)
}
