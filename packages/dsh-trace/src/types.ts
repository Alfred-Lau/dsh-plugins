/** dsh-trace configuration shape (mirrors the schema in config-schema.ts). */
export interface OtlpConfig {
  /** OTLP/HTTP base URL; `/v1/traces` is appended. */
  endpoint: string
  serviceName?: string
  serviceVersion?: string
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface LangfuseConfig {
  publicKey: string
  secretKey: string
  baseUrl?: string
  release?: string
  tags?: string[]
  timeoutMs?: number
}

export interface CaptureConfig {
  turns?: boolean
  steps?: boolean
  tools?: boolean
  llm?: boolean
}

export interface LlmCaptureConfig {
  /** Capture the sanitized request prompt (false = sizes only). */
  prompt?: boolean
  /** Capture the sanitized completion (false = sizes only). */
  completion?: boolean
}

export interface MetadataConfig {
  sessionId?: boolean
  model?: boolean
}

export interface SanitizeConfig {
  enabled?: boolean
  /** Extra key-name substrings treated as secrets (lowercase match). */
  redactKeys?: string[]
  /** Extra secret regex sources applied to string values. */
  redactPatterns?: string[]
  truncatePromptChars?: number
  truncateCompletionChars?: number
  truncateToolInputChars?: number
  truncateToolOutputChars?: number
  /** Per-attribute string budget for span attributes. */
  truncateAttributeChars?: number
}

export interface BatchConfig {
  /** Flush once this many completed spans are queued. */
  maxRecords?: number
  /** Timer flush interval (ms). */
  flushIntervalMs?: number
  /** In-memory queue bound; excess spans drop (metrics self-heal, traces warn). */
  maxQueueRecords?: number
}

export interface RetryConfig {
  /** Attempts per batch, including the first try. */
  maxAttempts?: number
  baseDelayMs?: number
  factor?: number
  maxDelayMs?: number
}

export interface TraceConfig {
  /** Master switch — off by default; nothing is captured or exported unless true. */
  enabled: boolean
  otlp?: OtlpConfig | null
  langfuse?: LangfuseConfig | null
  capture?: CaptureConfig
  llm?: LlmCaptureConfig
  metadata?: MetadataConfig
  sanitize?: SanitizeConfig
  batch?: BatchConfig
  retry?: RetryConfig
}

/**
 * Canonical projection of a dsh session event, produced by event-map.ts.
 * This is the stable internal shape the collector consumes, isolated from
 * dsh session-format drift (V3 embeds assistant streams in
 * `assistant/message` / `assistant/attempt`, etc.).
 */
export interface SessionEventProjection {
  sessionId: string
  /** Event timestamp, epoch ms. */
  ts: number
  kind: 'turn' | 'step' | 'tool' | 'llm'
  phase: 'start' | 'end'
  turn?: number
  step?: number
  tool?: {
    name: string
    callId?: string
    args?: unknown
    result?: unknown
    error?: string
    durationMs?: number
  }
  llm?: {
    provider?: string
    model?: string
    /** Input prompt tokens. NOTE: cache_read tokens are INCLUDED in this number. */
    inputTokens?: number
    /** Output tokens. NOTE: reasoning tokens are INCLUDED in this number. */
    outputTokens?: number
    cacheReadTokens?: number
    reasoningTokens?: number
    prompt?: unknown
    completion?: unknown
    error?: string
    durationMs?: number
  }
}

/** A completed span, ready to hand to backends. */
export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: SessionEventProjection['kind']
  sessionId: string
  turn?: number
  /** epoch ms */
  startTime: number
  /** epoch ms */
  endTime: number
  status: 'ok' | 'error'
  errorMessage?: string
  attributes: Record<string, string | number | boolean>
}
