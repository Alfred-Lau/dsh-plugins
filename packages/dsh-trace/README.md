# dsh-tracing

> npm package name is `dsh-tracing` (`dsh-trace` is blocked by npm name-similarity rules); the harness plugin id stays `dsh-trace`.

OpenTelemetry-compatible tracing for DeepSeek Harness sessions. Projects session
events into a span tree and exports them over **OTLP/HTTP (JSON)** or the
**Langfuse v3 ingestion API** — no vendor lock, no built-in panel, your existing
observability stack stays the source of truth.

## What you get

- **Span tree per session turn**: `invoke_agent turn N` (root) → `step N` →
  `execute_tool {name}` / `chat {model}`, with deterministic trace IDs
  (`sha1(sessionId:turn)`) so replays and cross-references stay stable.
- **GenAI semantic conventions**: `gen_ai.operation.name`, `gen_ai.request.model`,
  `gen_ai.usage.input_tokens` / `output_tokens`, plus cache-read and reasoning
  token details. Token invariants are respected: cache-read counts inside input,
  reasoning inside output — details are exported as attributes, never re-summed.
- **Three backends, fan-out enabled**: OTLP/HTTP (Jaeger, Tempo, Alloy, …),
  Langfuse (traces map to `trace-create`, tools/steps to `span-create`, LLM calls
  to `generation-create` with `usage` in Langfuse token units), and a generic
  HTTP usage gateway (raw span arrays or OpenMeter-style CloudEvents).
- **Sanitize before send**: built-in key redaction (`key`, `token`, `secret`,
  `password`, `authorization`, …), credential patterns (`sk-…`, `ghp_…`, `AKIA…`,
  `Bearer …`, PEM blocks), per-field truncation budgets, and an attribute-length
  cap. Custom keys/regexes merge in.
- **Batching with bounded memory**: records queue up to `batch.maxQueueRecords`,
  flush every `batch.flushIntervalMs` or `batch.maxRecords`, retried with
  exponential backoff up to `retry.maxAttempts`, then dropped with a warning —
  tracing never blocks or crashes a session.
- **Fail-safe lifecycle**: flushes on `session/flush` and `session/disposed`;
  missing starts still emit best-effort spans (zero-duration, status derived).

## Install & enable

```bash
dsh plugin --profile web add dsh-tracing
```

The bundled row ships `enabled: false`. Enable it in your profile patch:

```yaml
- insert:
  - id: dsh-trace
    name: dsh-tracing
    config:
      enabled: true
      otlp:
        endpoint: http://localhost:4318   # /v1/traces is appended
        serviceName: deepseek-harness
      # langfuse:
      #   publicKey: pk-lf-...
      #   secretKey: sk-lf-...
      #   baseUrl: https://cloud.langfuse.com
      # httpUsage:                       # OpenMeter-style metering gateway
      #   endpoint: https://meter.internal/api/v1/events
      #   headers: { authorization: Bearer ... }
      #   mode: usage                     # usage = CloudEvents, spans = raw JSON
```

> A profile-level patch targeting this id **replaces the whole row config**
> (no deep merge) — restate every key you want to keep.

## Configuration

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | No-op when false (logs and exits). |
| `otlp` | `object?` | – | OTLP/HTTP backend. `endpoint` required; `/v1/traces` appended automatically. Optional `serviceName` (`deepseek-harness`), `serviceVersion`, `headers`. |
| `langfuse` | `object?` | – | Langfuse backend. `publicKey`/`secretKey` required (Basic auth); optional `baseUrl` (cloud default), `release`, `tags`. |
| `httpUsage` | `object?` | – | Generic HTTP gateway backend. `endpoint` required; optional `headers`, `timeoutMs`, `mode` (`spans` posts the raw span JSON array, `usage` posts OpenMeter-compatible CloudEvents with token buckets from LLM spans only), `eventType`/`eventSource` (usage mode). |
| `capture.turns` / `capture.steps` / `capture.tools` / `capture.llm` | `boolean` | `true` | Per-kind capture switches. |
| `capture.llm.prompt` / `capture.llm.completion` | `boolean` | `true` | Include prompt/completion text (subject to truncation + sanitization). |
| `sanitize.enabled` | `boolean` | `true` | Master switch. |
| `sanitize.redactKeys` | `string[]` | `[]` | Extra key names to redact (case-insensitive substring match, merged with builtins). |
| `sanitize.redactPatterns` | `string[]` | `[]` | Extra regexes for values (invalid entries are skipped, not thrown). |
| `sanitize.truncatePromptChars` / `…CompletionChars` / `…ToolInputChars` / `…ToolOutputChars` | `number` | 4000/4000/2000/2000 | Per-field truncation budgets (marker appended: `…[truncated N chars]`). |
| `sanitize.truncateAttributeChars` | `number` | 1000 | Cap for any single span attribute string. |
| `metadata` | `object` | `{}` | Static key/values copied onto every span (`dsh.trace.*` prefix is reserved). |
| `batch.maxRecords` / `batch.flushIntervalMs` / `batch.maxQueueRecords` | `number` | 256 / 5000 / 2000 | Batching and queue bound. |
| `retry.maxAttempts` / `retry.baseDelayMs` / `retry.factor` / `retry.maxDelayMs` | `number` | 5 / 1000 / 2 / 60000 | Export retry backoff. |

## Event mapping

The collector consumes harness `session/event` broadcasts and makes a
best-effort projection (snake_case/camelCase, `type`/`event`/`kind`, nested or
flat payloads all tolerated):

| Event shape | Projection |
| --- | --- |
| `turn/start`, `turn/end` | `invoke_agent turn N` span (root of the turn's trace) |
| `step/start`, `step/end` | `step N` child span |
| `tool/start` + `tool/end` (matched by `callId`) | `execute_tool {name}` span |
| assistant/model/chat/message/attempt events | `chat {model}` span; usage fields (`input_tokens`, `output_tokens`, `cache_read…`, `reasoning…`) accepted in both cases |

Events this plugin does not model are silently skipped. Unpaired ends still emit
a best-effort span; the first `end` for a session closes any dangling parents.

## Known limitations (v0.1)

- Session events are shaped best-effort; harness payloads may evolve and the
  projector will miss fields it does not recognize (never crash).
- OTel `SpanKind` is always `INTERNAL` (1).
- The Langfuse mapping identifies observations by OTel span IDs — queries that
  join both views should use trace IDs.

## Compatibility

Targets `@deepseek-ai/cordis ^4.0.1`. See the repo-level
[compatibility policy](../../README.md#compatibility-policy) and the monthly CI job.

## License

MIT
