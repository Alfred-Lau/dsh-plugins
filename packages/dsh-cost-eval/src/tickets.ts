/**
 * Per-ticket cost rollup over dsh-trace span batches.
 *
 * dsh-trace stamps every span from a Super-agent Session with
 * `dsh.ticket.id` / `dsh.ticket.role`. This module folds those spans into one
 * cost row per ticket, which is what an operator actually needs: "what did
 * this ticket cost, and did it stay inside its budget?"
 *
 * Pricing is data, never a guess: `DEFAULT_PRICING` holds reference list prices
 * for the models we know, `--pricing <file>` overrides them, and any model
 * without a price is reported as `unpriced` instead of being silently costed
 * at zero.
 */

/** USD per million tokens. */
export interface ModelPrice {
  input: number
  output: number
  /** Cache-read tokens are billed at this rate when the provider prices them separately. */
  cacheRead?: number
}

export type PricingTable = Record<string, ModelPrice>

/**
 * Reference list prices (USD / 1M tokens), DeepSeek first-party models.
 *
 * These are defaults for local estimation only — provider prices change. Pass
 * `--pricing` with a table you maintain whenever the number has to be right.
 */
export const DEFAULT_PRICING: PricingTable = {
  'deepseek-chat': { input: 0.27, output: 1.1, cacheRead: 0.07 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.14 },
  'deepseek-v3': { input: 0.27, output: 1.1, cacheRead: 0.07 },
  'deepseek-r1': { input: 0.55, output: 2.19, cacheRead: 0.14 },
}

/** The subset of a dsh-trace span this module reads. */
export interface SpanLike {
  sessionId?: string
  kind?: string
  name?: string
  startTime?: number
  endTime?: number
  status?: string
  ticket?: { role?: string; ticketId?: string }
  attributes?: Record<string, unknown>
}

export interface TicketCost {
  /** Ticket id, or `(router)` for the master Session. */
  ticketId: string
  role: 'worker' | 'router' | 'unknown'
  sessions: string[]
  spans: number
  llmCalls: number
  toolCalls: number
  failedToolCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
  /** True when at least one model in this ticket had no price. */
  hasUnpricedModel: boolean
  models: string[]
  /** Epoch ms of the last span seen for this ticket. */
  lastSeen: number
}

export interface TicketReport {
  tickets: TicketCost[]
  totals: {
    tickets: number
    spans: number
    llmCalls: number
    toolCalls: number
    failedToolCalls: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    costUsd: number
  }
  /** Models seen without a price; their tokens are counted but not costed. */
  unpriced: string[]
  /** Budget per ticket, when one was supplied. */
  budgetUsd?: number
  /** Tickets whose cost exceeds the budget, most expensive first. */
  overBudget: TicketCost[]
  /** Spans that carried no ticket tag (not a Super-agent session). */
  untaggedSpans: number
}

function numAttr(attributes: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return 0
}

function strAttr(attributes: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attributes[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Looks a model up in the pricing table, tolerating vendor prefixes. */
export function priceFor(model: string, pricing: PricingTable): ModelPrice | undefined {
  if (pricing[model]) return pricing[model]
  const lower = model.toLowerCase()
  for (const [key, price] of Object.entries(pricing)) {
    if (lower === key.toLowerCase()) return price
  }
  // `deepseek/deepseek-chat` → `deepseek-chat`
  const tail = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower
  for (const [key, price] of Object.entries(pricing)) {
    if (tail === key.toLowerCase()) return price
  }
  return undefined
}

function costOf(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): number {
  // Cache-read tokens are a subset of input tokens; bill them at the cache
  // rate and the remainder at the full input rate.
  const cacheRead = Math.min(cacheReadTokens, inputTokens)
  const fullInput = Math.max(inputTokens - cacheRead, 0)
  const cacheRate = price.cacheRead ?? price.input
  return (fullInput * price.input + cacheRead * cacheRate + outputTokens * price.output) / 1_000_000
}

/**
 * Folds a span batch into per-ticket cost rows.
 *
 * Spans without a ticket tag are counted in `untaggedSpans` and otherwise
 * ignored — a plain Harness session has no ticket to bill.
 */
export function aggregateTickets(
  spans: readonly SpanLike[],
  pricing: PricingTable = DEFAULT_PRICING,
  budgetUsd?: number,
): TicketReport {
  const byTicket = new Map<string, TicketCost>()
  const unpriced = new Set<string>()
  let untaggedSpans = 0

  for (const span of spans) {
    if (!span || typeof span !== 'object') continue
    const role = span.ticket?.role
    if (role !== 'worker' && role !== 'router') {
      untaggedSpans += 1
      continue
    }
    const ticketId = role === 'router' ? '(router)' : span.ticket?.ticketId
    if (!ticketId) {
      untaggedSpans += 1
      continue
    }

    let row = byTicket.get(ticketId)
    if (!row) {
      row = {
        ticketId,
        role,
        sessions: [],
        spans: 0,
        llmCalls: 0,
        toolCalls: 0,
        failedToolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        hasUnpricedModel: false,
        models: [],
        lastSeen: 0,
      }
      byTicket.set(ticketId, row)
    }

    row.spans += 1
    if (span.sessionId && !row.sessions.includes(span.sessionId)) row.sessions.push(span.sessionId)
    const seen = span.endTime ?? span.startTime
    if (typeof seen === 'number' && seen > row.lastSeen) row.lastSeen = seen

    if (span.kind === 'tool') {
      row.toolCalls += 1
      if (span.status === 'error') row.failedToolCalls += 1
      continue
    }
    if (span.kind !== 'llm') continue

    row.llmCalls += 1
    const attributes = span.attributes ?? {}
    const input = numAttr(attributes, 'gen_ai.usage.input_tokens')
    const output = numAttr(attributes, 'gen_ai.usage.output_tokens')
    const cacheRead = numAttr(attributes, 'gen_ai.usage.details.cache_read')
    row.inputTokens += input
    row.outputTokens += output
    row.cacheReadTokens += cacheRead

    const model = strAttr(attributes, 'gen_ai.response.model', 'gen_ai.request.model')
    if (!model) {
      // A completion with no model name cannot be priced; flag it rather than
      // billing it at zero and pretending the ticket was cheap.
      row.hasUnpricedModel = true
      unpriced.add('(unknown model)')
      continue
    }
    if (!row.models.includes(model)) row.models.push(model)
    const price = priceFor(model, pricing)
    if (!price) {
      row.hasUnpricedModel = true
      unpriced.add(model)
      continue
    }
    row.costUsd += costOf(price, input, output, cacheRead)
  }

  const tickets = [...byTicket.values()].sort((a, b) => b.costUsd - a.costUsd || a.ticketId.localeCompare(b.ticketId))
  const totals = tickets.reduce(
    (acc, t) => ({
      tickets: acc.tickets + 1,
      spans: acc.spans + t.spans,
      llmCalls: acc.llmCalls + t.llmCalls,
      toolCalls: acc.toolCalls + t.toolCalls,
      failedToolCalls: acc.failedToolCalls + t.failedToolCalls,
      inputTokens: acc.inputTokens + t.inputTokens,
      outputTokens: acc.outputTokens + t.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + t.cacheReadTokens,
      costUsd: acc.costUsd + t.costUsd,
    }),
    {
      tickets: 0,
      spans: 0,
      llmCalls: 0,
      toolCalls: 0,
      failedToolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    },
  )

  const overBudget =
    budgetUsd === undefined ? [] : tickets.filter(t => t.costUsd > budgetUsd)

  return {
    tickets,
    totals,
    unpriced: [...unpriced].sort(),
    ...(budgetUsd === undefined ? {} : { budgetUsd }),
    overBudget,
    untaggedSpans,
  }
}

/**
 * Reads a span batch from whatever shape a trace export produced: a bare span
 * array, `{ spans: [...] }`, an OTLP `resourceSpans` envelope, or the
 * CloudEvents array from dsh-trace's `httpUsage` usage mode.
 */
export function extractSpans(input: unknown): SpanLike[] {
  if (Array.isArray(input)) {
    // CloudEvents array (usage mode) has no ticket — return what we can.
    return input.filter(s => typeof s === 'object' && s !== null) as SpanLike[]
  }
  if (typeof input !== 'object' || input === null) return []
  const record = input as Record<string, unknown>
  if (Array.isArray(record.spans)) return record.spans as SpanLike[]
  if (Array.isArray(record.resourceSpans)) return spansFromOtlp(record.resourceSpans)
  return []
}

/** Flattens an OTLP/JSON trace payload into span-like rows. */
function spansFromOtlp(resourceSpans: unknown): SpanLike[] {
  const out: SpanLike[] = []
  if (!Array.isArray(resourceSpans)) return out
  for (const resource of resourceSpans) {
    const scopeSpans = (resource as { scopeSpans?: unknown })?.scopeSpans
    if (!Array.isArray(scopeSpans)) continue
    for (const scope of scopeSpans) {
      const spans = (scope as { spans?: unknown })?.spans
      if (!Array.isArray(spans)) continue
      for (const span of spans) {
        const record = span as Record<string, unknown>
        const attributes: Record<string, unknown> = {}
        const rawAttrs = record.attributes
        if (Array.isArray(rawAttrs)) {
          for (const attr of rawAttrs) {
            const entry = attr as { key?: unknown; value?: Record<string, unknown> }
            if (typeof entry.key !== 'string' || !entry.value) continue
            const v = entry.value
            attributes[entry.key] =
              v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? undefined
          }
        }
        out.push({
          name: typeof record.name === 'string' ? record.name : undefined,
          kind: kindOf(attributes['dsh.trace.session_id'] !== undefined, attributes),
          startTime: otlpTime(record.startTimeUnixNano),
          endTime: otlpTime(record.endTimeUnixNano),
          status: (record.status as { code?: number })?.code === 2 ? 'error' : 'ok',
          attributes,
        })
      }
    }
  }
  return out
}

function otlpTime(nano: unknown): number | undefined {
  if (typeof nano !== 'string' && typeof nano !== 'number') return undefined
  const value = Number(nano)
  return Number.isFinite(value) ? Math.round(value / 1_000_000) : undefined
}

/** OTLP spans carry the kind only in `dsh.trace.*` attributes / span name. */
function kindOf(_hasSession: boolean, attributes: Record<string, unknown>): string | undefined {
  const op = attributes['gen_ai.operation.name']
  if (op === 'chat') return 'llm'
  if (op === 'execute_tool') return 'tool'
  if (typeof op === 'string' && op.startsWith('invoke_agent')) return 'turn'
  return undefined
}
