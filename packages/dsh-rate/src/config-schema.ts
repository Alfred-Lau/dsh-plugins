import Schema from '@deepseek-ai/schemastery'
import type { RateConfig } from './types.js'

export const Config: Schema<RateConfig> = Schema.object({
  enabled: Schema.boolean().default(false),
  mode: Schema.union(['monitor', 'enforce'] as const).default('monitor'),
  backoff: Schema.object({
    enabled: Schema.boolean().default(true),
    baseMs: Schema.number().default(30_000),
    factor: Schema.number().default(2),
    maxMs: Schema.number().default(600_000),
  }),
  budget: Schema.object({
    dailyTokens: Schema.number().default(0),
    warnAt: Schema.number().default(0.8),
    criticalAction: Schema.union(['log', 'block-tools'] as const).default('log'),
  }),
  toolStorm: Schema.object({
    windowMs: Schema.number().default(60_000),
    maxCalls: Schema.number().default(0),
  }),
  audit: Schema.object({
    enabled: Schema.boolean().default(true),
    file: Schema.string().default(''),
    maxBytes: Schema.number().default(5_242_880),
  }),
}) satisfies Schema<RateConfig>
