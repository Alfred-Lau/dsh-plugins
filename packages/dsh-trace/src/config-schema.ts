import Schema from '@deepseek-ai/schemastery'
import type { TraceConfig } from './types.js'

/**
 * Config schema for the cordis config row, built with the real
 * `@deepseek-ai/schemastery`. Kept permissive (generous defaults) so the
 * schema never rejects a config row the typed loader accepts; stricter
 * runtime checks live in `apply()`.
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(false),
  otlp: Schema.object({
    endpoint: Schema.string().default(''),
    serviceName: Schema.string().default('deepseek-harness'),
    serviceVersion: Schema.string().default(''),
    headers: Schema.dict(Schema.string()),
    timeoutMs: Schema.number().default(10_000),
  }),
  langfuse: Schema.object({
    publicKey: Schema.string().default(''),
    secretKey: Schema.string().default(''),
    baseUrl: Schema.string().default('https://cloud.langfuse.com'),
    release: Schema.string().default(''),
    tags: Schema.array(Schema.string()),
    timeoutMs: Schema.number().default(10_000),
  }),
  capture: Schema.object({
    turns: Schema.boolean().default(true),
    steps: Schema.boolean().default(true),
    tools: Schema.boolean().default(true),
    llm: Schema.boolean().default(true),
  }),
  llm: Schema.object({
    prompt: Schema.boolean().default(true),
    completion: Schema.boolean().default(true),
  }),
  metadata: Schema.object({
    sessionId: Schema.boolean().default(true),
    model: Schema.boolean().default(true),
  }),
  sanitize: Schema.object({
    enabled: Schema.boolean().default(true),
    redactKeys: Schema.array(Schema.string()),
    redactPatterns: Schema.array(Schema.string()),
    truncatePromptChars: Schema.number().default(4_000),
    truncateCompletionChars: Schema.number().default(4_000),
    truncateToolInputChars: Schema.number().default(2_000),
    truncateToolOutputChars: Schema.number().default(2_000),
    truncateAttributeChars: Schema.number().default(1_000),
  }),
  batch: Schema.object({
    maxRecords: Schema.number().default(256),
    flushIntervalMs: Schema.number().default(5_000),
    maxQueueRecords: Schema.number().default(2_000),
  }),
  retry: Schema.object({
    maxAttempts: Schema.number().default(5),
    baseDelayMs: Schema.number().default(1_000),
    factor: Schema.number().default(2),
    maxDelayMs: Schema.number().default(60_000),
  }),
}) satisfies Schema<TraceConfig>
