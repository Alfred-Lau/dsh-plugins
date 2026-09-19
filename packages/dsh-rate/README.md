# dsh-rate-shield

Rate & budget governance for DeepSeek Harness: 429 backoff windows, daily
token budgets and tool-call storm control — with a monitor-first default so
you can see the numbers before anything starts being denied.

**Plugin id:** `dsh-rate` · **npm:** `dsh-rate-shield`

## Install

```bash
dsh plugin --profile web add dsh-rate-shield
dsh --profile web --dump-config | grep -A3 'id: dsh-rate'   # verify
```

The plugin ships **disabled**.

## Modes

| mode | behavior |
|------|----------|
| `monitor` (default) | meter LLM usage, observe 429s, warn on budget thresholds — never deny |
| `enforce` | additionally **deny tool calls** while any shield condition is open |

## Shields

1. **429 backoff** — every observed 429 opens an exponentially growing quiet
   window (`baseMs`, `factor`, `maxMs`; default 30 s → 10 min cap). Any
   successful LLM completion resets the streak. In enforce mode, tool calls
   inside the window are denied with the remaining time in the reason.
2. **Daily token budget** — rolling per-UTC-day total of input+output tokens.
   Warns at `warnAt` (default 80%); at 100%, `criticalAction: block-tools`
   (enforce mode) denies tool calls until the day resets. The budget resets
   automatically at the UTC day boundary.
3. **Tool storm** — a rolling window (`windowMs` / `maxCalls`, e.g. 120
   calls/min); over-limit calls are denied in enforce mode.

## Honest limitations

The current dsh event surface has no short-circuit channel for **LLM
requests themselves** — the tool pipeline (`tools/pre-execute`) is the only
approval-chain seam. This shield therefore protects the *tool loop around
the model*: when the provider is rate-limited or the budget is gone, agent
tool activity pauses instead of piling onto requests that are about to fail.
Pair with `@goodandready/dsh-key-rotation` for multi-key setups.

## Config

```yaml
- id: dsh-rate
  name: dsh-rate-shield
  config:
    enabled: false
    mode: monitor               # monitor | enforce
    backoff: { enabled: true, baseMs: 30000, factor: 2, maxMs: 600000 }
    budget: { dailyTokens: 0, warnAt: 0.8, criticalAction: log }   # 0 = off
    toolStorm: { windowMs: 60000, maxCalls: 0 }                    # 0 = off
    audit: { enabled: true }    # default file: <cwd>/.dsh-rate-shield/audit.jsonl
```

> A profile-level patch targeting `id: dsh-rate` replaces the WHOLE config
> row (no deep merge) — restate every key you want to keep.

## Audit format (JSONL)

```json
{"ts":"2026-09-19T12:00:00.000Z","rate_version":"0.1.0","event":"backoff_deny","tool":"bash","backoff_remaining_ms":28123}
```

Events: `llm_usage` · `llm_429` · `llm_ok` · `budget_warn` · `budget_deny` · `backoff_deny` · `storm_hit` · `storm_deny`.

## Development

```bash
pnpm install && pnpm --filter dsh-rate-shield test
```

MIT licensed. Part of the [dsh-plugins](https://github.com/Alfred-Lau/dsh-plugins) monorepo.
