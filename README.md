# dsh-plugins

Community plugins for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness).

Six plugins, six jobs:

| Plugin | What it does | Key idea |
| --------- | --- | --- |
| [`dsh-trace`](./packages/dsh-trace) | Observability: project harness sessions into OpenTelemetry-compatible spans and export them | Ships your data to **your** existing backend (OTLP/HTTP collector or Langfuse). Sanitize-before-send. GenAI semconv aligned. |
| [`dsh-policy`](./packages/dsh-policy) | Declarative tool-call permission control with an audit trail | Three-dimensional rules (tool / command / path), first-match-wins with priorities, **fail-closed**, JSONL audit log. |
| [`dsh-pii`](./packages/dsh-pii) | PII detection & exfiltration guard | Checksum-validated detectors (emails, IDs, cards, keys), block outbound calls carrying PII, audit **without storing raw matches**. |
| [`dsh-memo`](./packages/dsh-memo) | Tool-result memoization (TTL + LRU) | Repeated identical tool calls short-circuit with an explanatory cached preview; mutating tools excluded by default. |
| [`dsh-rate`](./packages/dsh-rate) | 429 backoff, daily token budgets, tool-storm control | Exponential backoff windows + budget watermarks + storm gates; **monitor-first**, enforce is opt-in. |
| [`dsh-cost-eval`](./packages/dsh-cost-eval) | Quality × cost leaderboard and cost release gates over `dsh-eval` run records | Companion CLI to dsh-eval (not a runner): cost-per-success math, multi-run ranking, CI gate with explicit cost budgets. |

All plugins follow the [dsh plugin contract](#plugin-contract): a cordis-bundle
row (`cordis.patch.yml`), a schema-validated `Config`, and an `apply(ctx, config)`
entry point. They are vendored-dependency-free and target `@deepseek-ai/cordis ^4.0.1`.

## Why these exist

- **Observability is fragmented.** Existing community trace plugins each lock you
  to one vendor or one panel. `dsh-trace` is backend-agnostic: point it at any
  OTLP/HTTP endpoint (Jaeger, Tempo, Grafana Alloy, …) or Langfuse, fan out to
  both if you like, and keep the pipeline (batch → retry → drop-with-warning)
  out of your agent's hot path.
- **Permission control is the biggest gap.** Claude Code has PreToolUse hooks,
  Codex CLI has auto-review, Gemini CLI has a policy engine. The dsh ecosystem
  had only minimal allow/deny lists. `dsh-policy` brings a real rule model:
  glob tool patterns, regex command matching, path globs, priorities, explicit
  `allow` / `deny` / `ask` effects, and a fail-closed default.
- **PII protection was a total blank.** Agent sessions carry personal data into
  logs, observability backends and outbound tool calls. Nobody in the dsh
  ecosystem guarded that seam. `dsh-pii-gate` closes it with checksum-validated
  detectors and a no-raw-text audit trail.
- **Repeated tool calls burn real money.** Every duplicate `read_file` /
  `search` re-executes and re-fills the context window. `dsh-tool-memo` is the
  first real memoization layer for dsh.
- **Long-running agents hit rate limits unprepared.** 429 backoff, budget
  watermarks and storm control existed for every framework except dsh.
  `dsh-rate-shield` fills that hole honestly (see its README for scope).
- **Evaluation forgot about money.** dsh-eval tells you whether an agent
  passes a benchmark; it never tells you which candidate earns its tokens.
  `dsh-cost-eval` adds the quality × cost layer: cost-per-success across
  every candidate run, plus a CI gate so a model swap cannot silently
  double your bill.

## Quick start

```bash
# install into a profile (example: web)
dsh plugin --profile web add dsh-tracing
dsh plugin --profile web add dsh-tool-policy
dsh plugin --profile web add dsh-pii-gate
dsh plugin --profile web add dsh-tool-memo
dsh plugin --profile web add dsh-rate-shield
```

The bundled plugins ship **disabled** in their config row — the harness keeps
its default behavior until you opt in. Enable and configure them via a profile
patch (see each plugin's README and its `cordis.patch.yml` for a commented example).

`dsh-cost-eval` is a standalone CLI (no profile needed): point it at the
`run.json` records `dsh eval` writes to get a cost-effectiveness leaderboard
and a CI gate — see [its README](./packages/dsh-cost-eval).

## Development

```bash
pnpm install
pnpm -r build      # tsc → lib/
pnpm -r test       # build + node --test over test/*.ts
pnpm -r typecheck
```

Requires Node `^22.19.0 || >=24.0.0` (tests run on the native Node type-stripping
test runner, no transpile step for tests).

## Compatibility policy

dsh is a developer preview and may ship breaking changes. Both packages run a
**monthly compatibility check** against the latest published `@deepseek-ai/cordis`
(see [`.github/workflows/compat-monthly.yml`](./.github/workflows/compat-monthly.yml)).
The `peerDependencies` range is intentionally wide (`^4.0.1`); treat minor bumps
as "works until proven otherwise" and rely on the monthly job to catch drift.

## License

MIT — see [LICENSE](./LICENSE).
