# Agent Context OS

[English](../../en/architecture/context-os.md)

## 核心决策

持久任务状态属于 Polarbear；Codex 和 Claude Code session 是有界、可替换的执行环境。Context OS 扩展 Memory Engine，不替换 Option B 存储架构。

```text
Observe → Distill → Persist → Retrieve → Assemble Context
   ↑                                               ↓
Checkpoint ← Execute ← Context Packet ←───────────┘
```

## 领域模型

- **Task**：持久目标、状态、阶段、优先级和最新 checkpoint。
- **Checkpoint**：changed、learned、decision、constraint、failed attempt、verification、unresolved 和 remaining 的结构化 snapshot/delta。
- **Context Packet**：不可变、带版本、受 token 预算约束且保留来源的投影。
- **Agent Session**：provider session 的不透明映射，外部 ID 只保存 hash。
- **Execution Run**：一次 managed/assisted 执行尝试。
- **Observation**：已校验、脱敏的 provider-neutral 活动事件。
- **Usage Ledger / Retrieval Run**：上下文与 provider usage 证据。

领域合同以 `src/domain/context-os.ts` 为准。

## Context Planner

Planner 合并 Task、最新 Checkpoint、混合 Memory 检索和近期 task-scoped Memory，并为以下 P0 类别预留槽位：objective、working state、hard constraint、accepted decision、high-risk/disputed verification。

可选 Architecture、Episode、Verification 和 Semantic 候选只有在分类预算与总预算内才能进入。长内容可以截断，但保留 source ID。最终 packet 不得超过硬 token budget。

Packet 保存 hash、来源、选择原因、分类预算、排除原因、token 估算与检索耗时。当前请求只在返回值中存在，持久化时保存 digest。

未提供明确硬预算时，Planner 会根据请求规模、Task/Checkpoint、强制项和有界检索候选集，在 500 到 8,000 Token 之间确定自动预算。Workspace 使用 `custom` 模式时始终传入配置的硬预算。自动预算是确定性的，并且不会绕过 12,000 Token 的绝对安全上限。

## Lifecycle 集成

Provider-neutral `LifecycleOrchestrator` 把 lifecycle event 映射到已有 Context OS port。Claude Code lifecycle-managed 模式支持 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure、PostToolBatch、PreCompact、PostCompact、Stop、StopFailure 和 SessionEnd。

- payload 限长并脱敏；
- prompt 只保存 digest；
- SessionStart 解析显式 Task，或按确定性策略选择可继续 Task，并返回有界 continuation context；
- UserPromptSubmit 只在检索期间临时使用原始 prompt，并在模型处理前返回 prompt-specific additional context；
- Stop 和 StopFailure 执行 session-scoped 确定性 distillation，SessionEnd 只负责有界的最终 flush；
- PreCompact 保留已有结构化 continuation state，不再用通用 marker 覆盖；
- PostCompact 记录边界；由于该事件不能注入 context，下一次 prompt 负责 rehydration；
- fingerprint 保证幂等；
- 数据库失败时写入本地 spool，稍后 replay。

当前 distiller 只提取明确标记的 decision、pitfall、task state 和 next step，不声称能理解任意 tool output。

Codex 项目集成仍为 MCP-assisted，因为 stock Codex 没有向 Polarbear 暴露等价的项目 hook surface。Lifecycle-managed Codex 需要由 Polarbear 控制 App Server client，以便拦截 `turn/start` 并消费 thread、turn 和 item event；当前实现不宣称具备该 adapter。Admin API 会明确报告 `LIFECYCLE_MANAGED`、`MCP_ASSISTED` 或 `UNAVAILABLE`。

## Managed runtime 与 rotation

Managed session 默认关闭，需要设置 `POLARBEAR_MANAGED_SESSIONS=1`。

- Codex 默认 `read-only`，写入时使用 `workspace-write`。
- Claude Code 默认 `plan`，写入时使用 `acceptEdits`。
- model override 会传给 provider 并记录到 run。

Rotation 使用确定性规则。没有 durable checkpoint 时拒绝 rotation；允许时先持久化新的 rotation-boundary checkpoint。Resume 失败会记录失败 run，并使用相同 Task 和 Packet 启动新 session。

## Desktop UX 合同

Polarbear Desktop 是聚焦于 Context 的客户端，不是 Memory 数据库管理工具。主要流程是查看已组装 Context、搜索持久 Memory，以及处理少量异常；Context 顶部必须显示完整项目路径。

- Context 用量显示为已组装 token / 当前预算。预算模式只有 `auto` 和 `custom`，默认使用 `auto`。
- Context 首页通过 `contexts.current` 读取最近的不可变 Packet，汇总来源类别，并且只展示当前 Context、Memory 复用、Token 影响和异常健康状态。
- 节省量使用正数 `Token 节省` 百分比；如果组装后的 Context 高于对比基线，则显示 `Token 影响` 和正数的“增加”比例，不显示负缩减率。
- 普通 active Memory 无需批准。只有冲突、用户争议、重要但低置信度或已过期的 Memory 才需要处理。
- 确认异常会持久保存验证状态；拒绝后该 Memory 不再参与检索，但修订历史仍保留。
- 用户编辑会创建修订，并立即成为高置信、由用户确认的 Memory。Confirm 会提升置信度并清除 Attention；Reject 执行明确的 `REJECTED` 生命周期转换，不伪装成 Archive 或删除。
- Engine 与 MCP 生命周期自动管理。Desktop 通过 Admin API 显示 Codex 和 Claude Code 集成健康，并提供有界修复操作，不向普通用户暴露进程启停。
- Desktop 不直接读取项目配置、Agent 配置或 `memory.db`；预算、集成健康和修复全部通过版本化 Admin API。
- Desktop 一级导航只保留 Context、Memory 和 Settings。Raw History 保留时间仅以摘要显示，并只能在 Advanced 中修改；Durable Memory 不使用基于年龄的 TTL。

## 验证证据

自动化测试覆盖 Task/Checkpoint 持久化、P0 预算、Packet 来源、A/B/C fixture、Claude lifecycle、两种 CLI JSONL/权限合同、rotation checkpoint、resume 恢复以及 Codex ↔ Claude 双向 handoff。

真实 provider 计费、长期 dogfood 和发布时 CLI 兼容性属于外部发布证据。
