# 产品与路线图

[English](../../en/planning/product-and-roadmap.md)

## 产品定位

Polarbear 是面向编程 Agent 的本地优先上下文操作系统与长期工程记忆层。

核心承诺是：

> 持久项目状态属于 Polarbear；Agent session 是可替换的执行环境。

Polarbear 采集可复用的工程证据，沉淀长期知识，在 token 预算内重建任务上下文，并让 Codex 与 Claude Code 跨 session、跨 provider 延续工作。

## 产品原则

- 不携带无限增长的聊天历史，而是按任务重建有限上下文。
- 原始证据尽量无损保存，注入模型的上下文保持选择性和有界。
- canonical 数据保存在本地，并且可备份、可恢复。
- 核心保持 provider-neutral，provider 差异只放在 adapter。
- 召回内容始终按“不可信项目数据”处理。
- 保持已有 Memory、CLI、MCP 和持久数据兼容。

## 当前范围

已实现：

- Option B 的 Fact + Episode + Entity 长期记忆模型；
- 生命周期、验证、替代、保留、备份与恢复；
- Task、Checkpoint、Execution Run、Observation 和 Context Packet；
- 有预算、有来源、可解释的上下文规划；
- Claude Code hooks 与通用 MCP；
- 默认关闭的 Codex/Claude managed runtime；
- 确定性 session rotation 与跨 provider handoff；
- Desktop 使用的 Admin API；
- usage、retrieval 和逻辑上下文效率指标。

## 非目标

- 把完整聊天记录作为长期记忆；
- 替换 provider 自身的 compaction；
- 让 Desktop 直接读写 `memory.db`；
- 默认遥测、远程渲染或隐式联网；
- 通用工作流引擎或自动多 Agent swarm。

## 路线图

| 阶段 | 结果 | 状态 |
|---|---|---|
| Memory 基础 | Evidence、Knowledge、Entity、Relation、生命周期和检索 | 已实现 |
| Context 状态 | Task、Checkpoint、Execution Run、Context Packet | 已实现 |
| Context Planner | 优先级、硬预算、来源与解释 | 已实现 |
| Provider 集成 | Claude hooks、通用 MCP、Codex/Claude runtime | 已实现 |
| Rotation 与 handoff | 确定性策略、checkpoint 边界、resume 恢复 | 已实现 |
| 评估 | Usage ledger、A/B/C fixture、发布门禁 | 基线已实现 |
| 多 Agent 协同 | 并行执行、冲突协调、团队策略 | 等待真实项目验证稳定后立项 |

工程范围完成不等于公开发布认证，发布状态见[发布就绪状态](./release-readiness.md)。
