# dsh-tool-memo

Tool-result memoization for DeepSeek Harness. Idempotent tool calls that
repeat with identical arguments are served from a TTL cache instead of
re-executing — fewer wasted executions, fewer burned tokens, faster loops.

**Plugin id:** `dsh-memo` · **npm:** `dsh-tool-memo`

## Install

```bash
dsh plugin --profile web add dsh-tool-memo
dsh --profile web --dump-config | grep -A3 'id: dsh-memo'   # verify
```

The plugin ships **disabled**.

## How a hit behaves

| mode | on a cache hit |
|------|----------------|
| `hint` (default) | the re-execution is **denied** with an explanatory reason carrying a bounded preview of the cached value and instructions to bypass with the fresh flag |
| `inject` | **EXPERIMENTAL** — the verdict additionally carries the full cached result (`result` field) for harnesses that honor it; on ones that don't, the call simply re-executes |

The fresh flag (default `_memoFresh: true` in the tool arguments) always
bypasses lookup. Mutating and outbound tools (`bash`, writes, `http*`,
`send*`, …) are **excluded by default** — a cached side effect is worse than
a repeated one.

## Cache semantics

- **Key** = `sha256(tool, stable-serialized args)` — content-addressed, safe
  across sessions of the same profile.
- **TTL** per tool via `perToolTtl` globs, `defaultTtlMs` otherwise; a TTL of
  `0` disables caching for that tool.
- **LRU** bounded by `maxEntries` (default 256); hits refresh recency.
- Error results are never cached.

## Config

```yaml
- id: dsh-memo
  name: dsh-tool-memo
  config:
    enabled: false
    mode: hint                  # hint | inject (inject = experimental)
    defaultTtlMs: 600000        # 10 min
    perToolTtl:                 # first matching glob wins
      - { tool: read_file, ttlMs: 300000 }
      - { tool: "search*", ttlMs: 120000 }
    maxEntries: 256
    excludeTools: []            # empty = built-in mutating/outbound list
    includeTools: []            # empty = all non-excluded tools
    freshFlag: _memoFresh
    audit: { enabled: true }    # default file: <cwd>/.dsh-tool-memo/audit.jsonl
```

> A profile-level patch targeting `id: dsh-memo` replaces the WHOLE config
> row (no deep merge) — restate every key you want to keep.

## Audit format (JSONL)

```json
{"ts":"2026-09-19T12:00:00.000Z","memo_version":"0.1.0","event":"hit","tool":"read_file","key":"9296…","age_ms":4210}
```

Events: `store` · `hit` · `miss` · `skip` (not cacheable / fresh flag / error) · `evict`.

## Development

```bash
pnpm install && pnpm --filter dsh-tool-memo test
```

MIT licensed. Part of the [dsh-plugins](https://github.com/Alfred-Lau/dsh-plugins) monorepo.
