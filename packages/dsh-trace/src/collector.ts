import { createHash, randomBytes } from 'node:crypto'
import {
  ATTR,
  DSH_ATTR,
  OP,
  spanNameForLlm,
  spanNameForStep,
  spanNameForTool,
  spanNameForTurn,
} from './semconv.js'
import type { Sanitizer } from './sanitize.js'
import type { SessionEventProjection, Span, TraceConfig } from './types.js'

export interface CollectorOptions {
  config: TraceConfig
  sanitizer: Sanitizer
  /** Called with each completed span, in completion order. */
  onSpan: (span: Span) => void
}

type AttrValue = string | number | boolean

interface Pending {
  spanId: string
  traceId: string
  parentSpanId?: string
  name: string
  kind: SessionEventProjection['kind']
  turn?: number
  step?: number
  sessionId: string
  startTime: number
  attributes: Record<string, AttrValue>
  tool?: NonNullable<SessionEventProjection['tool']>
  llm?: NonNullable<SessionEventProjection['llm']>
}

/**
 * Builds a span tree from the projected event stream:
 *
 *   turn (invoke_agent, trace root)
 *     └── step
 *           ├── llm (chat {model}, GENERATION)
 *           └── tool (execute_tool {name})
 *
 * traceId is deterministic per (sessionId, turn) so replays of the same
 * session produce linkable traces. Dangling spans (missing end events) are
 * closed by `closeAll` at flush/dispose time so no trace loses its root.
 */
export class SpanCollector {
  private readonly pendingTurn = new Map<string, Pending>()
  private readonly pendingStep = new Map<string, Pending>()
  private readonly pendingTool = new Map<string, Pending>()
  private readonly pendingLlm = new Map<string, Pending>()
  private readonly turnCounter = new Map<string, number>()
  private readonly stepCounter = new Map<string, number>()
  private readonly seqCounter = new Map<string, number>()

  constructor(private readonly opts: CollectorOptions) {}

  feed(p: SessionEventProjection): void {
    const { config } = this.opts
    switch (p.kind) {
      case 'turn':
        if (config.capture?.turns === false) return
        this.onTurn(p)
        return
      case 'step':
        if (config.capture?.steps === false) return
        this.onStep(p)
        return
      case 'tool':
        if (config.capture?.tools === false) return
        this.onTool(p)
        return
      case 'llm':
        if (config.capture?.llm === false) return
        this.onLlm(p)
        return
    }
  }

  /** Close every dangling span for a session (or all sessions) with `now`. */
  closeAll(sessionId?: string, now = Date.now()): void {
    const close = (store: Map<string, Pending>) => {
      for (const [key, pending] of store) {
        if (sessionId && pending.sessionId !== sessionId) continue
        this.complete(store, key, pending, now, 'ok')
      }
    }
    close(this.pendingLlm)
    close(this.pendingTool)
    close(this.pendingStep)
    close(this.pendingTurn)
  }

  // ---------------------------------------------------------------- turn

  private onTurn(p: SessionEventProjection): void {
    const key = p.sessionId
    let turn = p.turn
    if (p.phase === 'start') {
      if (turn === undefined) {
        turn = (this.turnCounter.get(p.sessionId) ?? 0) + 1
        this.turnCounter.set(p.sessionId, turn)
      }
      const existing = this.pendingTurn.get(key)
      if (existing) {
        // New turn started without the previous one ending: close it first.
        this.complete(this.pendingTurn, key, existing, p.ts, 'ok')
      }
      const traceId = this.traceIdFor(p.sessionId, turn)
      const attributes: Record<string, AttrValue> = {
        [ATTR.operation]: OP.invokeAgent,
        [DSH_ATTR.turn]: turn,
      }
      this.addMetadata(attributes, p)
      this.pendingTurn.set(key, {
        spanId: this.newSpanId(),
        traceId,
        name: spanNameForTurn(turn),
        kind: 'turn',
        turn,
        sessionId: p.sessionId,
        startTime: p.ts,
        attributes,
      })
      return
    }
    // end
    const pending = this.pendingTurn.get(key)
    if (!pending) return
    if (turn !== undefined && pending.turn !== undefined && turn !== pending.turn) {
      // A different turn's end arrived; still close what we have.
      this.complete(this.pendingTurn, key, pending, p.ts, 'ok')
      return
    }
    this.complete(this.pendingTurn, key, pending, p.ts, 'ok')
  }

  // ---------------------------------------------------------------- step

  private onStep(p: SessionEventProjection): void {
    const key = `${p.sessionId}`
    const turn = this.currentTurn(p)
    if (p.phase === 'start') {
      const step = p.step ?? (this.stepCounter.get(p.sessionId) ?? 0) + 1
      this.stepCounter.set(p.sessionId, step)
      const turnPending = this.pendingTurn.get(p.sessionId)
      const attributes: Record<string, AttrValue> = {}
      attributes[DSH_ATTR.step] = step
      if (turn !== undefined) attributes[DSH_ATTR.turn] = turn
      this.addMetadata(attributes, p)
      this.pendingStep.set(key, {
        spanId: this.newSpanId(),
        traceId: turnPending?.traceId ?? this.traceIdFor(p.sessionId, turn ?? 0),
        parentSpanId: turnPending?.spanId,
        name: spanNameForStep(step),
        kind: 'step',
        turn,
        step,
        sessionId: p.sessionId,
        startTime: p.ts,
        attributes,
      })
      return
    }
    const pending = this.pendingStep.get(key)
    if (!pending) return
    this.complete(this.pendingStep, key, pending, p.ts, 'ok')
  }

  // ---------------------------------------------------------------- tool

  private onTool(p: SessionEventProjection): void {
    const tool = p.tool
    if (!tool) return
    const key = tool.callId ?? `${p.sessionId}:tool:${this.nextSeq(`${p.sessionId}:tool`)}`
    const turn = this.currentTurn(p)
    const parent = this.pendingStep.get(p.sessionId) ?? this.pendingTurn.get(p.sessionId)

    if (p.phase === 'start') {
      const attributes: Record<string, AttrValue> = {
        [ATTR.operation]: OP.executeTool,
        [ATTR.toolName]: tool.name,
      }
      if (tool.callId) attributes[ATTR.toolCallId] = tool.callId
      if (turn !== undefined) attributes[DSH_ATTR.turn] = turn
      this.addMetadata(attributes, p)
      this.pendingTool.set(key, {
        spanId: this.newSpanId(),
        traceId: parent?.traceId ?? this.traceIdFor(p.sessionId, turn ?? 0),
        parentSpanId: parent?.spanId,
        name: spanNameForTool(tool.name),
        kind: 'tool',
        turn,
        sessionId: p.sessionId,
        startTime: p.ts,
        attributes,
        tool,
      })
      return
    }

    const pending = this.pendingTool.get(key)
    if (!pending) {
      // End without a seen start: emit a zero-duration completed span with
      // whatever data the end event carries (still better than dropping it).
      const attributes: Record<string, AttrValue> = {
        [ATTR.operation]: OP.executeTool,
        [ATTR.toolName]: tool.name,
      }
      if (tool.callId) attributes[ATTR.toolCallId] = tool.callId
      this.emitFinishedSpan(
        {
          spanId: this.newSpanId(),
          traceId: parent?.traceId ?? this.traceIdFor(p.sessionId, turn ?? 0),
          parentSpanId: parent?.spanId,
          name: spanNameForTool(tool.name),
          kind: 'tool',
          turn,
          sessionId: p.sessionId,
          startTime: p.ts - (tool.durationMs ?? 0),
          attributes,
          tool,
        },
        p.ts,
        tool.error ? 'error' : 'ok',
        tool.error,
      )
      return
    }
    pending.tool = { ...pending.tool, ...tool }
    const status = pending.tool?.error ? 'error' : 'ok'
    this.complete(this.pendingTool, key, pending, p.ts, status)
  }

  // ----------------------------------------------------------------- llm

  private onLlm(p: SessionEventProjection): void {
    const llm = p.llm
    if (!llm) return
    const key = `${p.sessionId}:llm:${this.nextSeq(`${p.sessionId}:llm`)}`
    const turn = this.currentTurn(p)
    const parent = this.pendingStep.get(p.sessionId) ?? this.pendingTurn.get(p.sessionId)

    if (p.phase === 'start') {
      const model = llm.model ?? 'unknown'
      const attributes: Record<string, AttrValue> = { [ATTR.operation]: OP.chat }
      if (llm.provider) attributes[ATTR.provider] = llm.provider
      attributes[ATTR.requestModel] = model
      if (turn !== undefined) attributes[DSH_ATTR.turn] = turn
      this.addMetadata(attributes, p)
      this.pendingLlm.set(key, {
        spanId: this.newSpanId(),
        traceId: parent?.traceId ?? this.traceIdFor(p.sessionId, turn ?? 0),
        parentSpanId: parent?.spanId,
        name: spanNameForLlm(model),
        kind: 'llm',
        turn,
        sessionId: p.sessionId,
        startTime: p.ts,
        attributes,
        llm,
      })
      return
    }

    // LLM end events are self-contained enough to always emit: merge into an
    // open pending span when one exists, otherwise emit standalone.
    const pending = [...this.pendingLlm.entries()].find(
      ([, v]) => v.sessionId === p.sessionId,
    )?.[1]
    const target =
      pending ??
      ({
        spanId: this.newSpanId(),
        traceId: parent?.traceId ?? this.traceIdFor(p.sessionId, turn ?? 0),
        parentSpanId: parent?.spanId,
        name: spanNameForLlm(llm.model ?? 'unknown'),
        kind: 'llm' as const,
        turn,
        sessionId: p.sessionId,
        startTime: p.ts - (llm.durationMs ?? 0),
        attributes: { [ATTR.operation]: OP.chat, [ATTR.requestModel]: llm.model ?? 'unknown' } as Record<string, AttrValue>,
        llm: {},
      } satisfies Pending)
    target.llm = { ...target.llm, ...llm }
    if (llm.model) target.attributes[ATTR.requestModel] = llm.model
    if (llm.provider) target.attributes[ATTR.provider] = llm.provider
    if (pending) {
      this.completeLlm(pending, p.ts)
      for (const [k, v] of this.pendingLlm) {
        if (v === pending) this.pendingLlm.delete(k)
      }
    } else {
      // Standalone emit: completeLlm writes usage/prompt/completion attributes
      // and derives the status, then emits the finished span.
      this.completeLlm(target, p.ts)
    }
  }

  // -------------------------------------------------------------- helpers

  private complete(
    store: Map<string, Pending>,
    key: string,
    pending: Pending,
    endTime: number,
    status: 'ok' | 'error',
  ): void {
    store.delete(key)
    if (pending.kind === 'llm') {
      this.completeLlm(pending, endTime)
      return
    }
    if (pending.kind === 'tool' && pending.tool) {
      this.completeTool(pending, endTime, status)
      return
    }
    this.emitFinishedSpan(pending, endTime, status)
  }

  private completeLlm(pending: Pending, endTime: number): void {
    const llm = pending.llm
    const sanitizer = this.opts.sanitizer
    const cfg = this.opts.config
    const usage = {
      input: llm?.inputTokens,
      output: llm?.outputTokens,
      cacheRead: llm?.cacheReadTokens,
      reasoning: llm?.reasoningTokens,
    }
    // Token invariants: cache_read ⊆ input_tokens, reasoning ⊆ output_tokens.
    // Export the totals as the canonical usage attributes and the inclusion
    // subsets as details — never sum them anywhere.
    if (usage.input !== undefined) pending.attributes[ATTR.usageInput] = usage.input
    if (usage.output !== undefined) pending.attributes[ATTR.usageOutput] = usage.output
    if (usage.cacheRead !== undefined && usage.cacheRead > 0) {
      pending.attributes[ATTR.usageCacheRead] = usage.cacheRead
    }
    if (usage.reasoning !== undefined && usage.reasoning > 0) {
      pending.attributes[ATTR.usageReasoning] = usage.reasoning
    }
    const promptRaw = llm?.prompt
    const completionRaw = llm?.completion
    if (promptRaw !== undefined) {
      const promptText = sanitizer.text(promptRaw, cfg.sanitize?.truncatePromptChars ?? 4_000)
      pending.attributes['dsh.trace.prompt_chars'] = promptText.length
      if (cfg.llm?.prompt !== false && promptText) pending.attributes['dsh.trace.prompt'] = promptText
    }
    if (completionRaw !== undefined) {
      const completionText = sanitizer.text(completionRaw, cfg.sanitize?.truncateCompletionChars ?? 4_000)
      pending.attributes['dsh.trace.completion_chars'] = completionText.length
      if (cfg.llm?.completion !== false && completionText) {
        pending.attributes['dsh.trace.completion'] = completionText
      }
    }
    const status = llm?.error ? 'error' : 'ok'
    this.emitFinishedSpan(pending, endTime, status, llm?.error)
  }

  private completeTool(pending: Pending, endTime: number, status: 'ok' | 'error'): void {
    const tool = pending.tool
    const sanitizer = this.opts.sanitizer
    const cfg = this.opts.config
    if (tool?.args !== undefined) {
      pending.attributes['dsh.trace.tool_input'] = sanitizer.attribute(
        sanitizer.value(tool.args, cfg.sanitize?.truncateToolInputChars ?? 2_000),
      )
    }
    if (tool?.result !== undefined) {
      pending.attributes['dsh.trace.tool_output'] = sanitizer.attribute(
        sanitizer.value(tool.result, cfg.sanitize?.truncateToolOutputChars ?? 2_000),
      )
    }
    if (tool?.durationMs !== undefined) pending.attributes[DSH_ATTR.durationMs] = tool.durationMs
    const error = tool?.error
    if (error) pending.attributes['dsh.trace.tool_error'] = sanitizer.attribute(error)
    this.emitFinishedSpan(pending, endTime, error ? 'error' : status, error)
  }

  private emitFinishedSpan(
    pending: Pending,
    endTime: number,
    status: 'ok' | 'error' = 'ok',
    errorMessage?: string,
  ): void {
    const span: Span = {
      traceId: pending.traceId,
      spanId: pending.spanId,
      parentSpanId: pending.parentSpanId,
      name: pending.name,
      kind: pending.kind,
      sessionId: pending.sessionId,
      turn: pending.turn,
      startTime: pending.startTime,
      endTime: Math.max(endTime, pending.startTime),
      status,
      errorMessage,
      attributes: { ...pending.attributes },
    }
    // Final attribute sanitization pass (attribute budget applies everywhere).
    const sanitizer = this.opts.sanitizer
    for (const k of Object.keys(span.attributes)) {
      const v = span.attributes[k]
      if (typeof v === 'string') span.attributes[k] = sanitizer.attribute(v)
    }
    this.opts.onSpan(span)
  }

  private addMetadata(attributes: Record<string, AttrValue>, p: SessionEventProjection): void {
    const cfg = this.opts.config
    if (cfg.metadata?.sessionId !== false) attributes[DSH_ATTR.sessionId] = p.sessionId
  }

  private currentTurn(p: SessionEventProjection): number | undefined {
    if (p.turn !== undefined) return p.turn
    const pending = this.pendingTurn.get(p.sessionId)
    return pending?.turn
  }

  private nextSeq(scope: string): number {
    const next = (this.seqCounter.get(scope) ?? 0) + 1
    this.seqCounter.set(scope, next)
    return next
  }

  private traceIdFor(sessionId: string, turn: number): string {
    return createHash('sha1').update(`${sessionId}:${turn}`).digest('hex').slice(0, 32)
  }

  private newSpanId(): string {
    return randomBytes(8).toString('hex')
  }
}
