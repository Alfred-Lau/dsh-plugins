/**
 * Wires ticket-scoped denial into the tool pipeline.
 *
 * Two sources, in priority order:
 *   1. the `ticket` service from dsh-ticket-context (its configured rule table);
 *   2. this plugin's own `ticket.rules`, used when that service is absent or
 *      `ticket.useService` is false.
 *
 * Returns `undefined` when ticket enforcement is off, so `attachPolicy` skips
 * the pre-check entirely rather than running a no-op on every tool call.
 */
import { checkTicketDeny, compileTicketRules, type CompiledTicketDenyRule, type TicketScopeLike } from './ticket-rules.js'
import { extractCommands } from './matcher.js'
import type { TicketDenyVerdict } from './ticket-rules.js'
import type { PolicyConfig, ToolCallInput } from './types.js'

interface TicketServiceLike {
  scopeOf?: (sessionId: unknown) => TicketScopeLike | undefined
  rules?: unknown
}

export interface TicketGateHandle {
  gate: (call: ToolCallInput) => TicketDenyVerdict | undefined
  ruleCount: number
  source: string
}

const DEFAULT_WORKER_PREFIX = 'worker-'

function ticketServiceOf(ctx: unknown): TicketServiceLike | undefined {
  const getter = (ctx as { get?: (name: string) => unknown } | undefined)?.get
  if (typeof getter !== 'function') return undefined
  try {
    const service = getter.call(ctx, 'ticket')
    return typeof service === 'object' && service !== null ? (service as TicketServiceLike) : undefined
  } catch {
    return undefined
  }
}

/** Local scope derivation, used when dsh-ticket-context is not loaded. */
function localScopeOf(
  sessionId: string | undefined,
  masterId: string | undefined,
  workerPrefix: string,
): TicketScopeLike | undefined {
  if (!sessionId) return undefined
  if (workerPrefix.length > 0 && sessionId.startsWith(workerPrefix)) {
    const ticketId = sessionId.slice(workerPrefix.length)
    return ticketId.length > 0 ? { role: 'worker', ticketId } : undefined
  }
  if (masterId && sessionId === masterId) return { role: 'router' }
  return undefined
}

/** Shape accepted from either source; `tools` (service) and `allowedTools` (config) both mean the allow-list. */
interface RawRule {
  match: string
  blockedCommands?: string[]
  tools?: string[]
  allowedTools?: string[]
  budgetUsd?: number
}

function isRuleArray(value: unknown): value is RawRule[] {
  return Array.isArray(value) && value.every(rule => typeof rule === 'object' && rule !== null && typeof (rule as RawRule).match === 'string')
}

export function makeTicketGate(ctx: unknown, config: PolicyConfig): TicketGateHandle | undefined {
  const ticketConfig = config.ticket
  if (!ticketConfig?.enabled) return undefined

  const masterId = ticketConfig.masterId
  const workerPrefix = ticketConfig.workerPrefix ?? DEFAULT_WORKER_PREFIX

  const service = ticketConfig.useService === false ? undefined : ticketServiceOf(ctx)
  const serviceRules = service && isRuleArray(service.rules) ? service.rules : undefined
  const ownRules = ticketConfig.rules ?? []

  const usingService = serviceRules !== undefined && serviceRules.length > 0
  const rawRules: RawRule[] = usingService ? serviceRules : ownRules
  const compiled: CompiledTicketDenyRule[] = compileTicketRules(
    rawRules.map(rule => ({
      match: rule.match,
      blockedCommands: rule.blockedCommands ?? [],
      allowedTools: rule.tools ?? rule.allowedTools ?? [],
      ...(rule.budgetUsd === undefined ? {} : { budgetUsd: rule.budgetUsd }),
    })),
  )

  if (compiled.length === 0) return undefined

  const scopeOf = (sessionId: string | undefined): TicketScopeLike | undefined => {
    if (service?.scopeOf) {
      const scope = service.scopeOf(sessionId)
      return scope ? { role: scope.role, ticketId: scope.ticketId } : undefined
    }
    return localScopeOf(sessionId, masterId, workerPrefix)
  }

  return {
    ruleCount: compiled.length,
    source: usingService ? 'dsh-ticket-context' : 'config',
    gate: (call: ToolCallInput) => {
      const scope = scopeOf(call.sessionId)
      if (!scope) return undefined
      return checkTicketDeny(call, scope, compiled, extractCommands)
    },
  }
}
