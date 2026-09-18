/**
 * OpenTelemetry GenAI semantic conventions used by dsh-trace.
 *
 * The GenAI semconv set is still Development-stage; attribute names live in
 * `open-telemetry/semantic-conventions-genai`. Custom attributes MUST NOT go
 * under `gen_ai.*` (reserved for the standard) — we use `dsh.trace.*`.
 */

export const ATTR = {
  operation: 'gen_ai.operation.name',
  provider: 'gen_ai.provider.name',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  usageInput: 'gen_ai.usage.input_tokens',
  usageOutput: 'gen_ai.usage.output_tokens',
  /**
   * Token invariants (documented in the dsh tracing field notes):
   *  - cache_read tokens are INCLUDED in input_tokens (not additive);
   *  - reasoning tokens are INCLUDED in output_tokens.
   * They are therefore exported as *detail* attributes only.
   */
  usageCacheRead: 'gen_ai.usage.details.cache_read',
  usageReasoning: 'gen_ai.usage.details.reasoning',
  toolName: 'gen_ai.tool.name',
  toolCallId: 'gen_ai.tool.call.id',
  conversationId: 'gen_ai.conversation.id',
} as const

export const DSH_ATTR = {
  sessionId: 'dsh.trace.session_id',
  turn: 'dsh.trace.turn',
  step: 'dsh.trace.step',
  toolCallId: 'dsh.trace.tool_call_id',
  durationMs: 'dsh.trace.duration_ms',
} as const

export const SCOPE_NAME = 'dsh-trace'
export const SCOPE_VERSION = '0.1.0'

/** OTel operation names (aligned with GenAI semconv + the MSFT agent extension). */
export const OP = {
  chat: 'chat',
  executeTool: 'execute_tool',
  invokeAgent: 'invoke_agent',
} as const

/** Span naming pattern `{operation} {model-or-name}` per GenAI semconv. */
export function spanNameForLlm(model: string): string {
  return `${OP.chat} ${model}`
}

export function spanNameForTool(toolName: string): string {
  return `${OP.executeTool} ${toolName}`
}

export function spanNameForTurn(turn: number | undefined): string {
  return turn === undefined ? OP.invokeAgent : `${OP.invokeAgent} turn ${turn}`
}

export function spanNameForStep(step: number | undefined): string {
  return step === undefined ? 'step' : `step ${step}`
}
