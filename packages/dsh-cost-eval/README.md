# dsh-cost-eval

Cost-effectiveness reports and cost release gates over [dsh-eval](https://www.npmjs.com/package/dsh-eval) run records — the quality × cost layer dsh-eval leaves out.

dsh-eval answers *"does it work?"* (benchmark YAML, headless trials, trace metrics, `compare` for two runs). This package answers *"is it worth it?"*: fold 1..N run records into a quality × cost leaderboard, compute cost-per-successful-task, and gate model swaps in CI with explicit cost budgets.

It is a companion, **not a runner**: it never spawns trials, reads traces, or judges answers. Input is the `run.json` records `dsh eval run --out` already writes.

## Why

- `dsh eval compare` handles exactly two runs; model selection wants a ranked table across every candidate at once.
- dsh-eval reports cost and quality side by side but never combines them — cost-per-success and tokens-per-success are the numbers you actually choose with.
- Release gates check quality regressions; nobody checks that the cheap model actually stayed cheap after the swap.

## Install

```bash
npm install -g dsh-cost-eval
```

Or use it as a library (`normalizeRun` / `evaluate` / `gate` are exported from the package root). Zero runtime dependencies.

## CLI

```bash
# Leaderboard across every candidate model's run record
dsh-cost-eval report run-deepseek-v4.json run-deepseek-lite.json run-claude.json

# Machine-readable
dsh-cost-eval report *.json --json

# CI gate: candidate may cost at most 20% more, drop at most 10% quality,
# and must keep task success at or above 80%
dsh-cost-eval gate \
  --base run-deepseek-v4.json \
  --candidate run-deepseek-lite.json \
  --max-cost-increase-pct 20 \
  --max-quality-drop-pct 10 \
  --min-task-success-rate 0.8
```

Exit codes: `0` pass, `1` gate fail (wire it into CI), `2` usage/parse error.

## Scoring

Per run, folded from the record's `cases[]` (with `aggregate`/`grading` fallbacks):

- **quality** — the first available signal in [0, 1]: pooled `taskSuccessRate`, else mean judge score normalized by `judge.maxScore`, else pooled `toolSelectionAccuracyRate`. A single interpretable signal, not a weighted blend. `null` when a run has no grading or judge data (shown as `n/a`).
- **cost** — sum of per-trial `metrics.costUsd` (falls back to `aggregate.costUsd`). `null` without benchmark pricing.
- **cost/success, tokens/success** — totals divided by trials graded `taskSuccess: true`. `null` without graded successes; the package never pretends completed trials are successes.
- **Ranking** — quality descending, then cost-per-success ascending, then label. Unmeasured runs sort last, never hidden.

## Gate policy

| Check | Default limit | Fails when |
| --- | --- | --- |
| `costIncrease` | +20% | total cost grows past the budget |
| `qualityDrop` | -10% | quality signal drops past the budget |
| `minTaskSuccessRate` | off | absolute floor breached (opt-in) |
| `tokensPerSuccessIncrease` | +25% | token efficiency degrades past the budget (cost proxy when pricing is absent) |

Decision policy: a check fails only when both sides carry data and the limit is breached. Missing data yields an explicit `unverifiable` reason — the gate never fabricates a number, and never blocks a release just because one metric was unmeasured.

## Report schema tolerance

Records are parsed defensively against the dsh-eval 0.3 `EvalRun` shape (`cases[]` with `metrics`/`grade`/`judge`, pooled `aggregate`/`grading`). Unknown or missing fields degrade to `null` and surface as `n/a`; a record that is not a JSON object raises `InvalidRunError`. Per-trial fallbacks mean records without pooled fields still score.

## Honest limitations

- Not a runner: point `dsh eval` (or any producer of run records) at it; garbage records in, `n/a` out.
- Quality is single-signal by design; it will not invent a composite score from partial grading.
- Judge calls made by dsh-eval bill outside the measured trial cost — cost/success understates judge-scored runs (inherited from dsh-eval, documented there too).
- Cost figures are estimates from benchmark pricing tables, not invoices.

## Development

```bash
npm test          # build + node --test
npm run typecheck
```

MIT
