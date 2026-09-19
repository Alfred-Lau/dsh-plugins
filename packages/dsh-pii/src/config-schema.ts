import Schema from '@deepseek-ai/schemastery'
import type { PiiConfig } from './types.js'

/**
 * Config schema for the cordis config row. Kept permissive — the schema never
 * rejects a row the typed loader accepts; custom pattern errors surface at
 * compile time (compileDetectors warns and skips).
 */
export const Config: Schema<PiiConfig> = Schema.object({
  enabled: Schema.boolean().default(false),
  mode: Schema.union(['audit', 'block'] as const).default('audit'),
  outboundTools: Schema.array(Schema.string()),
  exemptTools: Schema.array(Schema.string()),
  detectors: Schema.object({
    email: Schema.boolean(),
    phone_cn: Schema.boolean(),
    phone_intl: Schema.boolean(),
    cn_id: Schema.boolean(),
    credit_card: Schema.boolean(),
    api_key: Schema.boolean(),
    ssn: Schema.boolean(),
    ipv4: Schema.boolean(),
    iban: Schema.boolean(),
  }),
  customPatterns: Schema.array(
    Schema.object({
      name: Schema.string().required(),
      pattern: Schema.string().required(),
    }),
  ),
  minMatches: Schema.number().default(1),
  scanResults: Schema.boolean().default(true),
  maxScanChars: Schema.number().default(100_000),
  audit: Schema.object({
    enabled: Schema.boolean().default(true),
    file: Schema.string().default(''),
    maxBytes: Schema.number().default(5_242_880),
  }),
}) satisfies Schema<PiiConfig>
