import type { SessionEventProjection } from './types.js'

/**
 * dsh session/event -> canonical projection.
 *
 * dsh's session format is still moving (developer preview; V3 embeds the
 * assistant stream in `assistant/message` / `assistant/attempt` and the system
 * prompt is surface node 0). This module is the ONLY place that knows about
 * dsh's event shapes; everything downstream consumes the stable projection.
 * When dsh renames fields, fix it here — nothing else changes.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function num(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

function pick(obj: unknown, keys: string[]): unknown {
  if (!isRecord(obj)) return undefined
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k]
  }
  return undefined
}

/** Map usage payloads across snake_case / camelCase dsh variants. */
function projectUsage(raw: unknown): SessionEventProjection['llm'] | undefined {
  const inputTokens = num(
    pick(raw, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']),
  )
  const outputTokens = num(
    pick(raw, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']),
  )
  const cacheReadTokens = num(
    pick(raw, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read_tokens', 'cacheReadTokens']),
  )
  const reasoningTokens = num(
    pick(raw, ['reasoning_tokens', 'reasoningTokens']),
  )
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return { inputTokens, outputTokens, cacheReadTokens, reasoningTokens }
}

function classifyLlmType(t: string): boolean {
  return (
    t.includes('assistant') ||
    t.includes('llm') ||
    t.includes('model') ||
    t.includes('chat') ||
    t.includes('attempt') ||
    t.includes('completion')
  )
}

function phaseOf(t: string, raw: Record<string, unknown>): 'start' | 'end' {
  if (t.includes('end') || t.includes('finish') || t.includes('complete') || t.includes('stop')) {
    return 'end'
  }
  if (t.includes('start') || t.includes('begin')) return 'start'
  // Message/attempt events describe a completed model response unless they are
  // explicitly a start variant (the two checks above already caught those).
  if (t.includes('message') || t.includes('attempt')) return 'end'
  // Events carrying results/usage/errors are completions by nature.
  if (pick(raw, ['result', 'usage', 'output', 'error', 'response']) !== undefined) return 'end'
  return 'start'
}

/**
 * Best-effort projection. Returns null for events this plugin does not model
 * (system prompt nodes, settings, UI events, …) — silently skipped.
 *
 * The harness broadcasts `session/event` as `(session, event)`: identity lives
 * on `session.header.id`, the payload on `event.data`. This module used to take
 * a single flat object with everything inlined, which meant every real event
 * failed the `type` check and returned null — the plugin produced no spans at
 * all against a live harness while its flat fixtures kept passing. Both shapes
 * are accepted so those fixtures still exercise the mapping logic.
 */
export function projectSessionEvent(
  first: unknown,
  second?: unknown,
): SessionEventProjection | null {
  if (isRecord(second) && str(second.type)) return projectBroadcast(first, second)
  if (isRecord(first) && str(first.type)) return projectFlat(first)
  return null
}

/** dsh hands tool arguments over as a JSON *string*; parse it when it is one. */
function parseJsonish(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const s = v.trim()
  if (!s.startsWith('{') && !s.startsWith('[')) return v
  try {
    return JSON.parse(s)
  } catch {
    return v
  }
}

/** Concatenated text of a dsh content-block array. */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    const text = str(block.text)
    if (text) parts.push(text)
  }
  return parts.length > 0 ? parts.join('') : undefined
}

/**
 * Project one `session/event` broadcast, given the two arguments the hook
 * actually receives.
 */
function projectBroadcast(
  session: unknown,
  event: Record<string, unknown>,
): SessionEventProjection | null {
  const type = str(event.type)
  if (!type) return null
  const t = type.toLowerCase()
  const ts = num(event.time) ?? Date.now()
  const sessionId =
    str(pick(pick(session, ['header']), ['id'])) ??
    str(pick(session, ['id'])) ??
    str(event.sessionId) ??
    'unknown'
  const data = isRecord(event.data) ? event.data : {}
  const turn = num(data.turn)
  const step = num(data.step)

  if (t === 'tool/call') {
    const name = str(data.name)
    if (!name) return null
    return {
      sessionId,
      ts,
      kind: 'tool',
      phase: 'start',
      turn,
      step,
      tool: {
        name,
        callId: str(data.callId),
        args: parseJsonish(data.arguments),
      },
    }
  }

  if (t === 'tool/result') {
    // The result event carries no tool name: the only link back to the start is
    // the callId buried in `message.source` (or the tool-result block itself),
    // which is why the collector keys tool spans on callId.
    const message = isRecord(data.message) ? data.message : {}
    const source = isRecord(message.source) ? message.source : {}
    const block = Array.isArray(message.content)
      ? message.content.find((c) => isRecord(c) && c.type === 'tool-result')
      : undefined
    const body = isRecord(block) ? block : {}
    const text = textOf(body.content)
    const isError = body.isError === true
    return {
      sessionId,
      ts,
      kind: 'tool',
      phase: 'end',
      turn,
      step,
      tool: {
        name: '',
        callId: str(body.toolCallId, source.callId),
        result: text,
        error: isError ? text : undefined,
      },
    }
  }

  if (t === 'assistant/message') {
    // A completed model response. `request/context` announced the model before
    // the call; the usage lands here. Phase `end` merges into the open llm span
    // when there is one and stands alone when there is not — and it has to be
    // self-sufficient, because only the first step of a turn has a matching
    // `request/context`. The provider/model live under `message.source`.
    const usage = projectUsage(data.usage)
    const message = isRecord(data.message) ? data.message : {}
    const source = isRecord(message.source) ? message.source : {}
    return {
      sessionId,
      ts,
      kind: 'llm',
      phase: 'end',
      turn,
      step,
      llm: {
        provider: str(data.provider, source.provider),
        model: str(data.model, message.model, source.model),
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cacheReadTokens: usage?.cacheReadTokens,
        reasoningTokens: usage?.reasoningTokens,
        completion: message.content,
      },
    }
  }

  if (t === 'request/context') {
    return {
      sessionId,
      ts,
      kind: 'llm',
      phase: 'start',
      turn,
      step,
      llm: { provider: str(data.provider), model: str(data.model) },
    }
  }

  if (t === 'turn/start' || t === 'turn/end') {
    return { sessionId, ts, kind: 'turn', phase: t === 'turn/start' ? 'start' : 'end', turn }
  }

  if (t === 'step/start' || t === 'step/end') {
    return { sessionId, ts, kind: 'step', phase: t === 'step/start' ? 'start' : 'end', turn, step }
  }

  return null
}

/** Flat shape: one object carrying the type and the payload together. */
function projectFlat(raw: Record<string, unknown>): SessionEventProjection | null {
  const type = str(raw.type, raw.event, raw.kind)
  if (!type) return null
  const t = type.toLowerCase()
  const ts = num(raw.ts, raw.timestamp, raw.time, raw.createdAt) ?? Date.now()
  const sessionId = str(raw.sessionId, raw.session_id, raw.session) ?? 'unknown'
  const turn = num(raw.turn, raw.turnIndex, raw.turn_index)
  const step = num(raw.step, raw.stepIndex, raw.step_index)

  if (t.includes('tool')) {
    const inner = isRecord(raw.tool) ? raw.tool : raw
    const name = str(inner.name, inner.toolName, inner.tool_name, (isRecord(raw.tool) ? raw.toolName : undefined))
    if (!name) return null
    return {
      sessionId,
      ts,
      kind: 'tool',
      phase: phaseOf(t, raw),
      turn,
      step,
      tool: {
        name,
        callId: str(raw.callId, raw.call_id, inner.callId, inner.call_id, raw.id),
        args: pick(raw, ['args', 'input', 'arguments', 'params']) ?? pick(inner, ['args', 'input', 'arguments']),
        result: pick(raw, ['result', 'output']),
        error: str(raw.error),
        durationMs: num(raw.durationMs, raw.duration_ms, raw.duration),
      },
    }
  }

  if (classifyLlmType(t)) {
    const usageRaw = pick(raw, ['usage', 'tokenUsage', 'token_usage'])
    const usage = usageRaw ? projectUsage(usageRaw) : projectUsage(raw)
    return {
      sessionId,
      ts,
      kind: 'llm',
      phase: phaseOf(t, raw),
      turn,
      step,
      llm: {
        provider: str(raw.provider, raw.providerName, raw.gen_ai_provider),
        model: str(raw.model, raw.modelName, raw.model_name, raw.gen_ai_request_model),
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        cacheReadTokens: usage?.cacheReadTokens,
        reasoningTokens: usage?.reasoningTokens,
        prompt: pick(raw, ['prompt', 'input', 'messages', 'request']),
        completion: pick(raw, ['completion', 'output', 'response', 'text', 'content']),
        error: str(raw.error),
        durationMs: num(raw.durationMs, raw.duration_ms, raw.duration),
      },
    }
  }

  if (t.includes('turn')) {
    return { sessionId, ts, kind: 'turn', phase: phaseOf(t, raw), turn }
  }

  if (t.includes('step')) {
    return { sessionId, ts, kind: 'step', phase: phaseOf(t, raw), turn, step }
  }

  return null
}
