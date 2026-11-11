import Schema from '@deepseek-ai/schemastery'
import type { MemoConfig } from './types.js'

export const Config: Schema<MemoConfig> = Schema.object({
  enabled: Schema.boolean().default(false),
  mode: Schema.union(['hint', 'inject'] as const).default('hint'),
  defaultTtlMs: Schema.number().default(600_000),
  perToolTtl: Schema.array(
    Schema.object({
      tool: Schema.string().required(),
      ttlMs: Schema.number().required(),
    }),
  ),
  maxEntries: Schema.number().default(256),
  excludeTools: Schema.array(Schema.string()),
  includeTools: Schema.array(Schema.string()),
  freshFlag: Schema.string().default('_memoFresh'),
  ticket: Schema.object({
    enabled: Schema.boolean().default(true),
    masterId: Schema.string().default(''),
    workerPrefix: Schema.string().default('worker-'),
    isolation: Schema.union(['ticket', 'session', 'none'] as const).default('ticket'),
  }),
  audit: Schema.object({
    enabled: Schema.boolean().default(true),
    file: Schema.string().default(''),
    maxBytes: Schema.number().default(5_242_880),
  }),
}) satisfies Schema<MemoConfig>
