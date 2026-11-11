# superagent-governance — 一张工单的完整生命周期

七个 `dsh` 插件叠在一起，给 `dsh-superagent` 补上它缺的运行时治理层。

这个目录是一个 **replay 仿真**：真实的 Cordis context、真实的七个插件、真实的 HTTP
collector，只有「模型」和「工具」是剧本里的假数据。之所以不跑真 Super-agent，是因为它
需要 GitHub App + LLM key + `dsh ^0.2.1-alpha.2`，一次 run 的成本和不确定性都不适合当
回归测试。

```bash
node examples/superagent-governance/run.mjs          # 人读的报告
node examples/superagent-governance/run.mjs --json   # 机器读
```

跑完在 `output/` 下留：

| 文件 | 内容 |
| --- | --- |
| `result.json` | 三张工单的逐步结果 + 11 条期望的命中情况 |
| `governed-tickets.md` | 按工单聚合的成本表（`dsh-cost-eval` 渲染） |
| `bare-tickets.md` | 对照组，空的 |
| `governed-*.jsonl` | 四个包的审计流，可以逐条看谁在哪一步说了话 |

## 它证明了什么

| 机制 | 在哪一步说话 | 包 |
| --- | --- | --- |
| 工单作用域 | 全程：从 `worker-t-1042` 解出 `t-1042` | `dsh-ticket-context` |
| 工单维度 trace | 每个 span 带 `dsh.ticket.id` / `dsh.ticket.role` | `dsh-tracing` |
| 工单维度成本 | 跑完按工单出表，超预算 exit 1 | `dsh-cost-eval` |
| 命令黑名单 | `/usr/bin/git push` 被拦（绝对路径绕不过去） | `dsh-tool-policy` |
| PII 外发 | 某张工单强制 block，其他工单仍是 audit | `dsh-pii-gate` |
| 工单预算 | 预算耗尽的工单被拦，别的工单不受影响 | `dsh-rate-shield` |
| 缓存隔离 | 同文件跨工单不命中，防串味 | `dsh-tool-memo` |

11 条剧本期望 11/11 命中。

## 剧本

三张工单，暴露面各不相同：

```js
const RULES = [
  { match: 't-1042', blockedCommands: ['git'], dailyTokens: 200_000, maxCalls: 4,  mode: 'enforce' },
  { match: 't-1043', blockedCommands: ['git'], dailyTokens: 120_000, maxCalls: 4,  mode: 'enforce' },
  { match: 't-1044', blockedCommands: [],      dailyTokens: 200_000, maxCalls: 30, mode: 'enforce' },
]
```

- **t-1042** 修登录 bug：读文件（第一次执行、第二次缓存命中）、想 `git push`（被拦）、跑测试、跑 lint、跑 build（第 5 次调用触发风暴）
- **t-1043** 审 PR：读同一个文件（跨工单缓存不命中，真的重读）、`gh pr comment` 里带了邮箱（被拦）、`gh pr view`（放行）
- **t-1044** 账单重构：先读文件（预算还够）、一次大 LLM 调用把预算烧穿、`npm test` 被拦

## 挂载顺序就是 waterfall 顺序

```js
await ctx.plugin(ticket, configs.ticket)   // 先发布 ticket 服务，后面都靠它
await ctx.plugin(trace, configs.trace)
await ctx.plugin(memo, configs.memo)       // 缓存命中不花钱，所以排在预算之前
await ctx.plugin(rate, configs.rate)
await ctx.plugin(pii, configs.pii)
await ctx.plugin(policy, configs.policy)   // regex 扫描最贵，放最后
```

`tools/pre-execute` 是 Cordis waterfall：listener 返回 `undefined` 会**终止**派发，所以
每个「我没意见」的路径都必须调 `next()`。七个包都遵守这一点，任意顺序叠都不会互相饿死
（`dsh-policy/test/waterfall-chain.test.ts` 有回归测试）。

## 接到真 Super-agent 上

在 `cordis.patch.yml` 的 `dsh-superagent-worker` preset 的 `plugins:` 数组末尾追加七个
包名，配置里写同一张 `RULES` 表即可。不需要改 Super-agent 一行源码 —— 关联键是它自己
已经在用的 `worker-<ticketId>` 会话命名（`src/executor/dsh.ts` 的 `workerSessionId()`）。
