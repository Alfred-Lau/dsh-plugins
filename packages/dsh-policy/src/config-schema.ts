import Schema from '@deepseek-ai/schemastery'
import type { PolicyConfig } from './types.js'

/**
 * Config schema for the cordis config row, built with the real
 * `@deepseek-ai/schemastery`. Kept permissive so the schema never rejects a
 * config row the typed loader accepts; validation lives in PolicyEvaluator
 * (which fails loud on bad rules at load time).
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(false),
  rules: Schema.array(
    Schema.object({
      id: Schema.string().required(),
      effect: Schema.union(['allow', 'deny', 'ask'] as const),
      priority: Schema.number().default(0),
      tools: Schema.array(Schema.string()),
      commands: Schema.array(Schema.string()),
      paths: Schema.array(Schema.string()),
      reason: Schema.string().default(''),
    }),
  ),
  defaultDecision: Schema.union(['allow', 'deny', 'ask'] as const).default('ask'),
  failClosed: Schema.boolean().default(true),
  pathArgs: Schema.array(Schema.string()),
  commandArgs: Schema.array(Schema.string()),
  audit: Schema.object({
    enabled: Schema.boolean().default(true),
    file: Schema.string().default(''),
    maxBytes: Schema.number().default(5_242_880),
  }),
}) satisfies Schema<PolicyConfig>
