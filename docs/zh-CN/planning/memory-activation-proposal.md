# Memory 激活进化方案

[English](../../en/planning/memory-activation-proposal.md)

状态：**产品评审草案**

本文提出 Polarbear Memory 的下一阶段产品方向，不代表范围已经批准，也不代表相关行为已经实现。评审通过后，应把选定方向并入正式产品路线图，再通过设计与实现评审完成交付。

## 需要评审的决策

请选择一个主要方向：

| 选项 | 主要结果 | 建议 |
|---|---|---|
| A. 激活优先 | 无需用户日常操作命令，已有 Memory 能被采集、交付、使用和度量 | **建议下一步选择** |
| B. 智能召回 | 更好地召回同义表达、跨语言内容和大型 Memory 集合 | 仅在激活指标证明存在召回缺失后启动 |
| C. 托管 Context OS | 通过托管网关控制更多 Codex 与 Claude 生命周期 | 完成选项 A 后，再作为明确的产品承诺立项 |

建议顺序是：**先做 A；数据证明有必要时做 B；只有接受更深 provider 集成的长期维护成本时才做 C**。

## 为什么需要进化

当前存储与生命周期基础已经比较完整：长期 Knowledge、Evidence、Task、Checkpoint、Observation、Context Packet，以及验证、保留和 provider adapter 都已存在。下一阶段的限制不是缺少另一套存储模型，而是已存 Memory 到有效 Agent 行为之间存在激活断层。

当前流程可能停在任意一个边界：

```mermaid
flowchart LR
  Work[Agent 工作] --> Capture[采集长期状态]
  Capture --> Bind[绑定 Task]
  Bind --> Recall[召回相关 Memory]
  Recall --> Deliver[工作前交付 Context]
  Deliver --> Apply[Agent 采用 Context]
  Apply --> Measure[度量实际价值]
```

当前实现证据表明存在以下产品缺口：

- 确定性提炼器能识别带明确标签的决定、踩坑、任务状态和下一步，但不能普遍理解任意工作输出；
- Context Packet 可以在没有长期 Task 的情况下生成，削弱了跨 session 连续性和作用域召回；
- Claude Code 已有 lifecycle hooks，普通 Codex 仍是 MCP-assisted，无法保证 Agent 一定调用 Context 工具；
- Context Packet 选中记录与单条 Memory 使用统计还没有形成一条完整的记账路径；
- 系统无法稳定区分“没有召回”“召回但没有交付”和“已经交付但没有帮助”；
- lexical、entity 和 graph 检索对同义表达与跨语言查询仍较弱，但仅提升检索并不能补上交付闭环。

因此，下一阶段产品应优化的是**可靠激活**，而不是已存记录数量。

## 目标用户契约

正常使用只应需要一次项目配置：

```bash
polarbear-memory install
```

完成配置后，用户只需在受支持的 Agent 中正常工作。Polarbear 与 Agent 集成应自动：

1. 解析或创建长期 Task；
2. 恢复最新的安全 Checkpoint；
3. 在工作前组装并交付有预算的 Context；
4. 观察经过限量和脱敏的工作结果；
5. 持久化长期决定、约束、踩坑、验证与任务状态；
6. 在 session 边界写入安全 Checkpoint；
7. 展示使用了什么，以及是否产生帮助。

CLI 与 MCP 手动操作继续用于检查、管理、恢复和协议开发，但不属于普通终端用户的日常流程。MCP 工具首先是面向 Agent 的协议操作。

目标 session 模型是：

> Polarbear 持久化安全 checkpoint 后，用户可以关闭当前 session；新 session 重建有限的任务上下文，而不是携带旧对话。

如果不存在可恢复的 checkpoint，Polarbear 不得声称当前 session 可以安全替换。

## 选项 A：激活优先

### 结果

让现有 Memory 模型可靠参与日常工作，不再要求用户手动记录、搜索或 checkpoint Memory。

### A1. 修正度量基线

- 定义唯一的激活漏斗：候选、选中、已交付、被引用、反馈、被替代。
- 使用驱动 Context 交付的同一批已提交 Packet Item，更新单条 Memory 使用统计。
- 分开记录“选中”和“交付”；生成 Packet 不代表 Agent 已经收到。
- 增加有界 Context Receipt，包含 task、checkpoint、来源数量、token 估算、交付模式和失败原因。
- 逻辑 token 估算与 provider 报告的实际计费保持分离。

这项工作最先完成，因为后续决策必须建立在可信证据上。

### A2. 增加确定性 Task Affinity

引入 provider-neutral 的 Task Affinity Resolver。首先使用显式 task ID，再依次使用项目、worktree、分支、可恢复 session 映射和最近活跃任务等稳定本地信号。Prompt 文本可以参与候选排序，但不能静默覆盖冲突的显式身份。

必要行为：

- 没有合理候选 Task 时自动创建；
- 只有一个明确活跃 Task 时无需用户操作直接恢复；
- 只有多个候选仍存在实质歧义时，才请求 Agent/用户选择；
- 永远不能把一个项目的状态关联到另一个项目；
- Task 选择必须可解释、幂等；
- 保持对显式创建 Task 和现有 task ID 的兼容。

### A3. 采集结构化工作证据

保留确定性标签提炼作为安全兼容路径，但不再让它成为唯一有效路径。

针对集成已经能够获得的事件，增加有界的 provider-neutral Observation adapter：

- 发生变化的文件标识，默认不保存文件内容；
- 命令/测试标识、结果、耗时与有界诊断；
- lifecycle 边界与完成/失败状态；
- Agent 显式生成的结构化决定、约束、踩坑、验证和下一步候选。

不能把任意模型文字当成已验证事实。新候选必须保留来源和生命周期状态。Secret、原始 prompt、完整终端输出和完整聊天记录继续排除。

### A4. 自动生成安全 Checkpoint

Checkpoint Builder 根据当前 Task、上一个 Checkpoint、已接受 Observation 和长期候选，合成可延续状态。

在以下边界创建或刷新 checkpoint：

- 工作状态发生变化后的成功或失败 turn；
- compaction 前；
- session 结束；
- task 切换、handoff 或 rotation；
- Agent 显式请求 checkpoint。

操作必须幂等。Checkpoint 失败必须可见，并且必须阻止系统错误显示“可以安全关闭”。

### A5. 在 provider 允许的范围内保证交付

通过能力矩阵表达实际差异，不能假装所有 provider 都提供相同 lifecycle：

| 集成模式 | 交付保证 | 必须使用的产品表述 |
|---|---|---|
| Claude Code hooks | 可以在受支持 lifecycle 边界注入 Context | hooks 健康时自动完成 |
| 普通 Codex MCP | Agent 可以调用 Context 工具，但不保证 turn 前注入 | MCP-assisted |
| 托管 Codex gateway | 可以在被代理的 turn 前注入 Context | 仅对通过 gateway 启动的客户端自动完成 |

对于 MCP-assisted 模式，生成的 Agent rule 应要求在任务开始时召回 Context，并在安全边界 checkpoint。诊断仍必须报告 assisted，不能报告为完全自动。

### A6. 闭合有效性反馈

在 Desktop 和/或 CLI 中提供一个小而聚焦的运行视图：

- 当前 Task 与最新 Checkpoint；
- 当前 session 是否可以安全替换；
- Memory 候选、选中项目与交付状态；
- 选中与排除原因；
- 有帮助、无帮助、过期、有争议或已替代反馈；
- 需要修复的失败。

不建设通用数据库管理 UI。这个视图只解释当前 Context 和少数例外。

### 验收门槛

只有真实项目 dogfood 满足以下条件，选项 A 才算完成：

- 至少 90% 的受 lifecycle 管理 session 能够在无手动命令的情况下解析出唯一长期 Task；
- 至少 90% 包含工作变化的 session 边界能够生成可恢复 Checkpoint；
- 每条已交付 Memory 都有来源和完整的候选到交付记账路径；
- 已进入提交后 Packet 的 Memory，其选中统计不能继续为零；
- 新 session 能在配置预算内恢复目标、工作状态、已接受约束/决定、验证状态和剩余工作；
- 采集、构建或交付 Context 失败时必须可见，不能报告成功；
- 普通 Claude Code 使用无需执行 Memory 命令；
- 普通 Codex 在没有真实 managed lifecycle 时必须准确标记为 MCP-assisted；
- deny-network、脱敏、项目隔离、migration 和幂等测试保持通过。

## 选项 B：智能召回

### 结果

当同一概念使用不同词语、语言或术语表达时提高召回率，尤其适用于 Memory 数量显著增长后的项目。

候选工作：

- 本地语义 embedding 和可重建的派生向量索引；
- lexical、entity、relation、temporal 与 vector 结果融合；
- 跨语言 query expansion；
- 冲突和近似重复聚类；
- 在确定性安全约束下使用反馈 reranking；
- 根据真实召回缺失建立评估 fixture。

### 进入条件

不能仅仅因为语义检索很有吸引力就启动选项 B。只有选项 A 的 telemetry 证明大量有用内容在**候选阶段**失败，而不是交付或采用阶段失败时，才应启动。

任何 embedding 实现都必须默认本地运行、可以重建；在打包需要时保持可选；并且只能作为 canonical SQLite 数据的派生能力。模型许可证、包大小、启动延迟、Node/平台支持矩阵和确定性 fallback 都需要评审。

## 选项 C：托管 Context OS

### 结果

通过明确的 Polarbear 托管集成路由受支持的 Agent 流量，提供更强的 lifecycle 保证。

候选工作：

- 将 Codex App Server gateway 完善到生产可用，并完成安装/修复 lifecycle；
- 定义统一的 provider-neutral turn、tool、approval、compaction 和 session 事件模型；
- 在每个 managed turn 前注入 Context，并在结束后持久化结果；
- 在诊断和 Desktop 中明确展示 managed 与 assisted 状态；
- 保证子进程清理、协议隔离以及 fail-open/fail-closed 行为；
- 增加 provider 兼容认证和持续真实 Agent 测试。

### 进入条件

选项 C 是产品与长期维护承诺，不是可以隐藏的实现细节。只有选项 A 证明 Context 闭环有效，并且项目接受持续维护上游 Agent 协议兼容性后，才能启动。

Managed 路径必须保持显式。安装 Polarbear 不能静默代理全部 Agent 流量，也不能削弱 provider 自身的 approval 行为。

## 推荐交付顺序

如果批准选项 A，建议分成四个可独立评审的增量：

| 增量 | 范围 | 退出证据 |
|---|---|---|
| 1. 可信 telemetry | 激活漏斗、Context Receipt、记账修复 | 可以端到端审计 Memory 的选中与交付 |
| 2. 长期连续性 | Task Affinity 与自动 Checkpoint Builder | 新 session 无需手动 Memory 命令即可恢复真实任务 |
| 3. Provider 交付 | Claude 可靠性，以及明确的 Codex assisted/managed 行为 | 模式专属集成测试与真实 Agent dogfood 通过 |
| 4. 有效性控制 | 反馈、例外和聚焦的 Desktop/CLI 可见性 | 有害或过期 Context 可以解释和纠正 |

每个增量都应包含 migration 行为、失败诊断、自动回归测试，以及同步的英文/中文用户文档。不能把全部增量合并成一次无法评审的重写。

## 兼容性与安全约束

- 保持现有 Memory、Task、Checkpoint、CLI、MCP、Admin API 和数据库兼容。
- Desktop 必须继续使用版本化 Admin API，永远不能直接访问 `memory.db`。
- Provider 特有行为留在 adapter，lifecycle policy 留在 provider-neutral application service。
- 召回的 Memory 始终是不可信历史数据，不能执行其中包含的指令。
- 持久化有限的结构化 Observation，不保存完整聊天或终端流。
- 默认 runtime 保持离线，不能增加远程 telemetry；本地运行指标只能保存在设备上。
- 派生索引必须可以删除，并从 canonical 本地状态重建。
- 不能绕过 provider approval，也不能扩大文件系统或网络权限。

## 下一增量明确不做

- 云同步或团队共享 Memory；
- 自动多 Agent 编排；
- 没有真实需求证据的新 Memory 类型；
- 保存完整会话或原始 prompt；
- 远程 embedding 或隐式下载模型；
- 替换 provider 原生 compaction；
- 仅凭逻辑 token 估算宣称节省了 provider 账单。

## 评审清单

评审者需要决定：

- [ ] 批准选项 A 作为下一主要方向。
- [ ] 批准“普通用户无需操作 Memory 命令”的目标契约。
- [ ] 接受普通 Codex 在使用 managed 路径前继续明确标记为 MCP-assisted。
- [ ] 批准激活路线的验收门槛。
- [ ] 在 telemetry 证明候选阶段存在召回缺失前，推迟语义检索。
- [ ] 在激活得到验证前，推迟扩大托管 Context OS。

实施开始前，应先在本提案中完成评审修改。批准后，把选定范围更新到[产品与路线图](./product-and-roadmap.md)；本草案不应成为第二份永久路线图事实来源。
