# agent-hub — dsh-plugins 全家桶一键集成

把 dsh-plugins 的五个**护栏** bundle 装进任意 dsh profile，并套上推荐配置。
再加一个可选的评测 CLI（dsh-cost-eval）。目标是：**一条命令，从 demo 到生产。**

## 一键安装

```bash
cd examples/agent-hub
bash install.sh            # 默认 profile: web
# bash install.sh smoke    # 指定其它 profile
# bash install.sh web --pin ../dist   # 优先用本地 tgz（详见下文 dsh-tracing 说明）
```

脚本会：

1. 依次 `dsh plugin --profile <p> add` 五个包（tracing / policy / pii / memo / rate-shield）；
2. 把 `agent-hub.patch.yml` **幂等**合并进 `<profile>/cordis.patch.yml`（以 bundle id 为锚点：已存在的段落原地更新，缺的追加，**绝不改动你已有的其它插件配置**）；
3. 末尾附 dsh-cost-eval CLI 的可选安装提示。

装完验证：

```bash
dsh --profile web --dump-config | grep -E 'id:|name:'
```

## 它装了哪六件事

| 插件 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| dsh-tracing | 观测 | on | OTLP + 可选 httpUsage 用量网关（0.2.0） |
| dsh-tool-policy | 安全 | on, fail-closed | 工具调用策略门禁 |
| dsh-pii-gate | 安全 | on, **block** | 敏感数据外发拦截 |
| dsh-tool-memo | 省钱 | on, hint | 重复读/检索返回值记忆 |
| dsh-rate-shield | 省钱/防护 | on, **enforce** | 限流 + 日预算 + 退避 |
| dsh-cost-eval | 评测(CLI) | 可选 | 质量 × 成本评测与 CI 门禁 |

安全护栏默认是"宁可拦、不可漏"（pii=block、policy=fail-closed、rate=enforce）。
想先观望，就把对应 `enabled` 改 false，或把 pii/rate 的 `mode` 改成 `audit`/`monitor`。

## dsh-tracing 0.2.0 与 httpUsage

`httpUsage` 用量网关后端（把 LLM token 用量以 OpenMeter 兼容 CloudEvents 推到你的
计费/评测网关）在 **0.2.0** 才可用，而 npm 线上当前还是 0.1.1。若要用它：

```bash
cd dsh-plugins && pnpm --filter dsh-tracing pack
# 把生成的 dsh-tracing-0.2.0.tgz 放到某个目录下，例如 dist/
bash examples/agent-hub/install.sh web --pin ../dist
```

装好后启用 `agent-hub.patch.yml` 里被注释的 `httpUsage` 段即可。

## 推荐配置怎么调

`agent-hub.patch.yml` 顶部注释说明了每个转折点：

- **只想观望**：pii → `mode: audit`；rate → `mode: monitor`；policy → `defaultDecision: ask` 是默认。
- **省钱叙事**：maiormemo 的 `mode: inject` 是实验性，非必要别开；`defaultTtlMs`/`maxEntries` 按需。
- **日预算**：rate 的 `budget.dailyTokens` 默认 500000；设 `0` 关闭。
- **审计日志**：默认落在 `<cwd>/.dsh-{policy,pii,rate}/audit.jsonl`，记得 `.gitignore`。

## 评测闭环（monitor → evaluate）

1. tracing 在 profich `httpUsage` 攒 usage 事件；或直接用 `dsh eval` 产出 run.json。
2. 用 dsh-cost-eval 出性价比报告 & 门禁：

```bash
npm i -g dsh-cost-eval
dsh-cost-eval report run.json
dsh-cost-eval gate --base baseline.json --candidate candidate.json
```

## 目录

```
agent-hub/
  install.sh          # 一键安装 + 幂等合并 patch
  agent-hub.patch.yml # 推荐全家桶配置（install.sh 合并源）
  README.md
```