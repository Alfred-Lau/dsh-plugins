# dsh-plugins

Community plugins for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness).

Two plugins, two jobs:

| Plugin | What it does | Key idea |
| --- | --- | --- |
| [`dsh-trace`](./packages/dsh-trace) | Observability: project harness sessions into OpenTelemetry-compatible spans and export them | Ships your data to **your** existing backend (OTLP/HTTP collector or Langfuse). Sanitize-before-send. GenAI semconv aligned. |
| [`dsh-policy`](./packages/dsh-policy) | Declarative tool-call permission control with an audit trail | Three-dimensional rules (tool / command / path), first-match-wins with priorities, **fail-closed**, JSONL audit log. |

Both plugins follow the [dsh plugin contract](#plugin-contract): a cordis-bundle
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

## Quick start

```bash
# install into a profile (example: web)
dsh plugin --profile web add dsh-tracing
dsh plugin --profile web add dsh-tool-policy
```

Both plugins ship **disabled** in their bundled config row — the harness keeps
its default behavior until you opt in. Enable and configure them via a profile
patch (see each plugin's README and its `cordis.patch.yml` for a commented example).

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
