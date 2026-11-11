import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_WORKER_PREFIX, type TicketConfig } from './scope.js'

export type { TicketConfig } from './scope.js'

export const Config: Schema<TicketConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  masterId: Schema.string().default(''),
  workerPrefix: Schema.string().default(DEFAULT_WORKER_PREFIX),
  rules: Schema.array(
    Schema.object({
      match: Schema.string().required(),
      tools: Schema.array(Schema.string()).default([]),
      blockedCommands: Schema.array(Schema.string()).default([]),
      budgetUsd: Schema.number().min(0),
    }),
  ).default([]),
}) satisfies Schema<TicketConfig>
