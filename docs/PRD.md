# Polarbear Memory 产品需求文档（PRD）

> **产品定义**：面向 AI 编程 Agent 的本地优先、跨 Agent、可验证的持久记忆层。  
> **版本**：v1.0 Draft  
> **文档日期**：2026-08-16  
> **首个产品版本**：Polarbear Memory v0.1  
> **状态**：可进入技术设计与开发拆解  

---

## 1. 文档目的

本文定义 Polarbear Memory 的产品定位、目标用户、核心场景、范围、体验、功能需求、数据与接口边界、质量指标、风险和 roadmap，作为产品、工程、设计、测试与发布决策的统一基线。

本 PRD 同时明确一个关键架构关系：

- **Polarbear Memory** 是可独立安装和运行的 Engine / CLI / MCP Server / Agent Adapter。
- **Polarbear Desktop** 是 Memory 的可选管理界面与知识浏览器。
- 即使未安装或未启动 Polarbear Desktop，Memory 也必须能够正常工作。
- Polarbear Desktop 只能通过稳定 API / SDK 使用 Memory，不直接读写其 SQLite 数据库。

## 2. 产品摘要

### 2.1 产品名

**Polarbear Memory**

### 2.2 类别

AI Engineering Knowledge Layer / Persistent Memory Infrastructure for AI Coding Agents

### 2.3 一句话定位

Polarbear Memory 记住项目中发生过什么、为什么这样做、什么仍然有效，以及下一步应该做什么，并在 Agent 需要时用最少 token 提供可验证的上下文。

### 2.4 用户价值主张

> Your coding agent shouldn't rediscover your project every morning.

Polarbear Memory 让新的 Agent session 能够快速延续未完成工作，复用过去的决策和经验，识别可能已过期的结论，并避免把全部历史塞进上下文窗口。

### 2.5 核心价值

1. **Continue instantly**：跨 session 直接续做，而不是重新探索项目。
2. **Fewer tokens**：按任务与预算编译上下文，减少无效读取和 prompt 膨胀。
3. **Never repeat yourself**：沉淀决策、失败路径、约定和任务状态，避免反复解释与重复踩坑。
4. **Trust, but verify**：每条记忆带来源、证据和生命周期；代码变化后显式提示陈旧风险。
5. **Agent independent**：Claude Code 今天学到的内容，未来可被 Codex、Cursor 或其他 Agent 使用。

## 3. 背景与问题

AI 编程工具已具备规则文件、自动记忆、Skills、Hooks 或 MCP 等能力，但项目知识仍然分散在会话、规则文件、提交、文档和不同厂商的私有记忆中。现有方案通常缺少统一的生命周期、来源追踪、陈旧检测和 token 预算控制。

### 3.1 核心问题

| 问题 | 典型表现 | 用户损失 |
| --- | --- | --- |
| Session Amnesia | 隔天或换 session 后重新解释上下文 | 时间与 token 浪费 |
| Re-discovery | Agent 重复 grep、读文件、查 Git | 首次有效行动慢 |
| Context Rot | 长会话中关键约束被噪音淹没 | 决策质量下降 |
| Lost Rationale | Git 记录改了什么，却没有完整记录为什么 | 重复分析或错误回滚 |
| Repeated Mistakes | 过去验证失败的方法被再次尝试 | 测试和调试成本增加 |
| Fragmentation | 规则、聊天、提交、文档分散 | 找不到可信答案 |
| Stale Memory | 旧结论在代码变化后仍被当成真相 | 产生比“没有记忆”更危险的误导 |
| Memory Overload | 全量历史被注入 prompt | 上下文占用与推理成本上升 |

### 3.2 需要解决的根问题

本产品不以“保存更多内容”为目标，而以以下问题为核心：

> 在给定任务、项目状态和 token 预算下，哪些历史信息现在仍然相关、可信，并应以什么粒度提供给 Agent？

因此核心能力是：

**Memory Retrieval + Lifecycle Management + Context Compression**

而不是 Conversation Archive 或通用向量数据库。

## 4. 产品原则

1. **Local-first**：默认数据只保存在用户设备上；核心路径不依赖云服务。
2. **Progressive disclosure**：先提供短上下文地图，详情按需展开。
3. **Evidence over assertion**：重要记忆必须尽可能关联来源、文件、symbol、commit 或测试结果。
4. **Staleness is a first-class state**：不隐藏不确定性；陈旧风险必须进入检索、展示与提示。
5. **SQLite is the brain; Markdown is the notebook**：机器高频记忆进数据库，人类关心的长期知识可提升为 Markdown。
6. **Agent-independent core**：Skill 只是入口，核心能力属于独立 Engine。
7. **Invisible by default, controllable when needed**：自动工作，但用户能查看、修正、验证、提升和遗忘。
8. **No transcript hoarding**：默认不保存完整对话，只提取未来可复用的知识。
9. **Benchmark before claims**：不以主观感受宣传效果，用可重复实验衡量收益和风险。
10. **Polarbear is optional**：Desktop 提升可见性与可管理性，但不成为 Agent 使用 Memory 的前置条件。
11. **Memory must earn its place**：短期知识在任务结束后退出活跃上下文，长期知识按证据而非年龄判断；自动淘汰出上下文，物理删除必须由用户确认。

## 5. 目标与非目标

### 5.1 v0.1 产品目标

v0.1 只需要证明一个核心假设：

> 开发者隔一天重新打开同一项目的新 Claude Code session，Agent 能否在不重新大范围探索的情况下，准确延续昨天的工作？

具体目标：

- 新 session 能在首次广泛检索前获得 800–1,500 token 的相关 Context Pack。
- 相比无 Memory 基线，重复探索成本至少降低 40%。
- 能自动捕获任务状态、关键决策、失败路径、约定和下一步。
- 每条返回的记忆可追溯到来源，并明确显示陈旧或低置信风险。
- 用户可通过 CLI 和 Polarbear Viewer 查看、修正、验证、提升或遗忘记忆。
- 安装后正常使用无需反复执行 `/save-memory`、`/handoff` 或 `/remember-this`。
- 已完成任务、被替代结论和无价值候选不会随 session 数量持续堆积在活跃上下文中。
- 长期运行时 Context Pack 污染率应 ≤ 5%，关键知识召回率应 ≥ 95%，且 canonical Memory 不会被自动物理删除。

### 5.2 非目标

v0.1 不做：

- 通用个人知识库或聊天记录归档。
- 云端账户、团队同步、多人冲突处理。
- 默认启用 Vector DB 或 embedding。
- 自动理解整个代码结构并替代 CodeGraph。
- 支持所有 Agent；v0.1 只对 Claude Code 做完整支持。
- 根据记忆自动修改代码或执行命令。
- 无法解释来源的“黑盒真相库”。
- Polarbear Desktop 内嵌或复制一份独立 Memory Engine。
- 对外承诺尚未通过 benchmark 的节省比例或成功率。

## 6. 目标用户与 Jobs to Be Done

### 6.1 核心用户

**个人开发者 / AI-heavy developer**

- 每天使用 Claude Code、Codex 或 Cursor 完成真实开发任务。
- 经常跨 session、跨天或跨 Agent 工作。
- 项目包含大量隐性约定、失败经验和未完成任务。
- 关心本地隐私、token 成本与结果可信度。

### 6.2 次级用户

- 维护多个仓库的独立开发者。
- 需要审阅 AI 工作历史的 Tech Lead。
- 希望把 AI 经验沉淀为团队知识的工程团队（v0.3+）。
- 使用 Polarbear 管理技术文档与工程知识的用户。

### 6.3 核心 JTBD

1. 当我开始一个新 session 时，我希望 Agent 立即知道上次做到哪里，从而直接继续工作。
2. 当我问“为什么这样设计”时，我希望看到历史决策、依据、相关提交和当前代码变化，而不只是搜索结果。
3. 当 Agent 准备尝试已失败的方法时，我希望系统提醒过去的失败原因和证据。
4. 当代码已经变化时，我希望旧记忆被降权并标记“需要验证”。
5. 当一条经验长期有效时，我希望把它提升为可提交、可评审的 Markdown 知识。
6. 当我切换 Agent 时，我希望历史上下文继续可用，而不是被某个厂商锁定。

## 7. 关键使用场景

### 7.1 Session Resume（v0.1 killer feature）

用户在昨天的 session 中修改了若干文件、遇到测试失败并确定下一步。今天新建 session 后输入：

```text
Continue fixing the redemption issue.
```

Agent 在大范围探索前调用：

```text
memory_context(task="Continue fixing the redemption issue", budget=1000)
```

返回：

- 当前目标和上次完成状态。
- 已确认的决策和项目约定。
- 已失败的方法及原因。
- 可能相关的文件、symbol 和 commit。
- 下一步建议。
- 任何需要重新验证的旧记忆。

### 7.2 Why / Rationale 查询

用户问“为什么 FAILED 是 terminal state？”系统结合历史决策、来源 session、commit 与当前代码给出短答案，并允许展开完整证据。

### 7.3 Repeated Mistake Prevention

Agent 提议一种曾导致测试失败的实现。Memory 返回 `PITFALL` / `FAILURE`，说明旧方法、失败原因、测试证据和适用范围。

### 7.4 Stale Memory Warning

一条记忆关联的文件或 symbol 在后续提交中发生显著变化。系统将其标记为 `POTENTIALLY_STALE`，检索时降低权重并明确要求验证。

### 7.5 Promote to Durable Knowledge

用户或系统识别出长期有效的决策，将 operational memory 整理并提升到：

```text
.polarbear/knowledge/
  decisions/
  architecture/
  pitfalls/
```

Markdown 可进入 Git、接受 diff review，并保持与数据库记忆的引用关系。

### 7.6 Cross-agent Continuity（v0.2）

Claude Code 产生的结构化记忆，在下一次 Codex 或 Cursor session 中通过同一 Memory Engine 被检索。

## 8. 端到端体验

### 8.1 安装与初始化

目标体验：

```bash
brew install polarbear-memory
cd my-project
polarbear-memory init
```

初始化结果应清晰说明：

```text
✓ Git repository
✓ Claude Code detected
✓ MCP configured
✓ Session hooks configured
✓ Local memory store initialized
✓ .polarbear/config.toml created

Polarbear Memory is ready.
```

要求：

- `init` 必须幂等。
- 修改第三方配置前创建可恢复备份并显示具体变更。
- 支持 `--dry-run`。
- 不强制安装 Polarbear Desktop。
- 支持 `doctor` 检查 MCP、hooks、权限、数据库与 Git 状态。

### 8.2 Session Start

1. Adapter 检测 repo root、branch、HEAD、Agent 与 session ID。
2. 向 Agent 注入一条轻量指令：先调用 `memory_context`，再进行大范围探索。
3. Context Compiler 针对当前任务生成预算内 Context Pack。
4. Agent 可用 `memory_get` 按需展开单条记忆。

### 8.3 Session During

Event Collector 只采集有潜在知识价值的结构化事件，例如：

- 文件编辑及关联路径。
- Git branch / HEAD 变化。
- 测试或构建结果摘要。
- Agent 明确做出的决策、发现、失败原因和下一步。
- 用户显式要求记住或忘记的内容。

不采集无意义过程话术，例如“我先看看”“正在检查”。

### 8.4 Session End

1. Hook 触发 session finalization。
2. Extractor 从结构化事件和 Agent 生成的结束摘要中提取候选记忆。
3. 进行去重、分类、scope 识别、敏感信息过滤与证据绑定。
4. 高置信候选进入 `ACTIVE`，其余进入 `CANDIDATE` 待验证。
5. 写入任务进度、未完成事项和下一步。
6. 原始临时事件按保留策略删除。

### 8.5 用户控制

用户必须能：

- 查看 Memory 的内容、类型、scope、来源、证据和状态。
- 编辑或纠正记忆，并保留 revision history。
- 标记 verified / disputed。
- 将旧记忆标记 superseded，并关联新记忆。
- archive / forget 记忆。
- 将记忆提升为 Markdown。
- 查看本次 Context Pack 为什么包含或排除某条记忆。
- 临时暂停采集或对路径配置排除规则。

## 9. 信息架构与记忆模型

### 9.1 Memory Types

| 类型 | 含义 | 示例 |
| --- | --- | --- |
| `DECISION` | 有明确取舍和理由的决定 | 使用 Redis lock 而不是 DB lock |
| `FACT` | 当前可验证的项目事实 | Settlement 使用 T+1 |
| `CONVENTION` | 项目约定 | 金额统一使用 BigDecimal |
| `PITFALL` | 容易犯错的模式 | 此处不能使用 RoundingMode.UP |
| `FAILURE` | 已发生失败及原因 | 某 API 因 scope 不足返回 403 |
| `WORKAROUND` | 临时规避方案 | PROD DNS 临时解析策略 |
| `TASK_STATE` | 当前任务进度与阻塞 | reconciliation 已完成 Step 3 |
| `TODO` | 明确的下一步 | 补 recovery test |
| `COMMAND` | 可复用的正确命令 | 本地启动与测试方式 |
| `ARCHITECTURE` | 结构或边界知识 | order → settlement → wallet |
| `PREFERENCE` | 项目或用户偏好 | 修改后必须运行指定测试集 |

### 9.2 核心字段

每条 Memory 至少包含：

- `id`
- `content`：完整内容。
- `summary`：面向 Context Pack 的短摘要。
- `type`
- `scope`：project / branch / module / file / symbol / task / user。
- `project_id`
- `branch_pattern`（可空）
- `file_paths[]`
- `symbols[]`
- `commit_sha`（可空）
- `task_id` / `session_id`（可空）
- `created_at` / `updated_at`
- `last_verified_at`（可空）
- `confidence`：0–1。
- `importance`：0–1。
- `source_type` / `source_ref`
- `lifecycle_status`
- `verification_state`
- `supersedes_id`（可空）
- `content_hash`

### 9.3 生命周期

为了避免把“是否仍生效”和“是否被验证”混成一个枚举，数据模型拆为两个维度。

**Lifecycle status**：

```text
CANDIDATE → ACTIVE → POTENTIALLY_STALE → SUPERSEDED / ARCHIVED
       └──────────────→ REJECTED
```

**Verification state**：

```text
UNVERIFIED / VERIFIED / DISPUTED
```

规则：

- `CANDIDATE`：刚提取、证据不足或可能重复。
- `ACTIVE`：允许正常检索使用。
- `POTENTIALLY_STALE`：依赖的代码或环境已明显变化，只能带警告返回。
- `SUPERSEDED`：被新决策替代，默认不进入 Context Pack，但可用于解释历史。
- `ARCHIVED`：不再活跃，保留历史。
- `REJECTED`：错误或无价值候选。
- `VERIFIED` 不代表永久有效；验证后仍可因代码变化进入 `POTENTIALLY_STALE`。

### 9.4 关系类型

- `SUPPORTS`
- `CONTRADICTS`
- `SUPERSEDES`
- `DERIVED_FROM`
- `RELATED_TO`
- `CAUSED_BY`
- `RESOLVED_BY`
- `APPLIES_TO`

关系可连接 memory、session、task、commit、file、symbol、test evidence 和 durable knowledge 文档。

## 10. 存储设计与数据所有权

### 10.1 双层存储

| 层 | 存储 | 作用 |
| --- | --- | --- |
| Operational Memory | SQLite + FTS5 | 高频自动写入、筛选、排序、关系与生命周期 |
| Durable Knowledge | Markdown + Git | 人类可读、可评审、可共享的长期知识 |

### 10.2 目录建议

项目仓库中只保存配置和可提交知识：

```text
my-project/
  .polarbear/
    config.toml
    knowledge/
      decisions/
      architecture/
      pitfalls/
```

数据库位于操作系统用户数据目录：

```text
<platform-data-dir>/Polarbear Memory/projects/<project-id>/memory.db
```

要求：

- SQLite 数据库不得默认放入 Git 仓库。
- 使用 WAL、foreign keys、事务与显式 schema migration。
- 数据库版本必须可向前迁移；破坏性迁移前自动备份。
- 项目 ID 优先由标准化 remote identity 派生，无 remote 时使用 repo root identity，并允许显式重绑定。
- Markdown 删除不应静默删除数据库历史；通过关系状态同步。

### 10.3 建议的 v0.1 数据表

- `projects`
- `sessions`
- `tasks`
- `memories`
- `memory_revisions`
- `memory_relations`
- `evidence`
- `memory_evidence`
- `file_anchors`
- `raw_events`
- `context_packs`
- `context_pack_items`
- `retrieval_feedback`
- `schema_migrations`
- `memories_fts`（FTS5 virtual table）

## 11. 系统架构

```text
Claude Code / Cursor / Codex / Other Agents
                     │
             MCP + Hooks + Skills
                     │
                     ▼
          Polarbear Memory Interfaces
        CLI / MCP Server / Adapter / SDK
                     │
                     ▼
           Polarbear Memory Core Engine
  Extraction / Lifecycle / Retrieval / Context Compiler
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
      SQLite/FTS5    Git    Optional Providers
                         Filesystem / CodeGraph
                     │
                     ▼
              Stable API / SDK
                     │
                     ▼
              Polarbear Desktop
       Timeline / Decisions / Search / Review
```

### 11.1 建议实现边界

- `core`：纯领域逻辑，不能依赖特定 Agent 或 UI。
- `storage`：SQLite、FTS5、migration、transaction。
- `git`：repo identity、branch、commit、diff 与变更范围。
- `extractor`：事件归一化、候选提取、分类、去重、证据绑定。
- `lifecycle`：验证、陈旧、替代、归档策略。
- `retrieval`：metadata filter、FTS、关系扩展、排序与去重。
- `context-compiler`：token 预算、压缩、分区与输出解释。
- `mcp`：稳定工具协议。
- `cli`：安装、初始化、诊断、搜索、管理与 benchmark。
- `adapters/claude-code`：Skill 与 hooks。
- `sdk`：供 Polarbear Desktop 和未来客户端使用。
- `providers`：Git、filesystem、未来 CodeGraph。

### 11.2 与 CodeGraph 的边界

Polarbear Memory 不重新实现代码图谱。

| 系统 | 负责 |
| --- | --- |
| Polarbear Memory | WHY / HISTORY / STATE / EXPERIENCE / NEXT |
| CodeGraph（可选） | WHERE / SYMBOL / CALL GRAPH / DEPENDENCY / STRUCTURE |
| Git | CHANGE / AUTHORSHIP / TIMELINE / DIFF |

Context Compiler 可组合 Historical Context、Structural Context 和 Current Change，但 CodeGraph 缺失时核心产品仍须正常运行。

## 12. MCP 工具合约

v0.1 暴露以下工具；所有写操作必须返回变更后的实体、来源和状态。

### 12.1 `memory_context`

为当前任务生成预算内 Context Pack。

输入：

- `task: string`（必填）
- `budget_tokens: integer`（默认 1000，范围 200–4000）
- `project?: string`
- `branch?: string`
- `include_types?: MemoryType[]`
- `max_stale_risk?: number`

输出：

- `context_markdown`
- `estimated_tokens`
- `memory_ids[]`
- `warnings[]`
- `omitted_summary`
- `explain_id`

### 12.2 `memory_search`

按 query、type、scope、status、时间、文件、symbol 和 branch 检索摘要列表。

### 12.3 `memory_get`

读取单条记忆的完整内容、revision、关系和证据。

### 12.4 `memory_record`

显式记录候选或已确认记忆；支持幂等键和 evidence。

### 12.5 `memory_verify`

验证、反驳或纠正记忆；记录 verifier、时间、依据和当前 commit。

### 12.6 `memory_forget`

归档、拒绝或按用户明确要求彻底删除记忆。彻底删除必须明确确认，不应由 Agent 静默执行。

### 12.7 `memory_status`

返回项目记忆统计、待处理候选、潜在陈旧项、数据库健康和最近采集状态。

### 12.8 MCP 通用要求

- 默认返回摘要，不返回大段原始事件或完整 transcript。
- 任何列表接口必须分页且有明确上限。
- 错误必须可操作，例如“项目未初始化”“证据文件已变化”。
- 输出字段具备 schema version。
- 写操作支持 `dry_run` 或等价预览机制。
- 工具描述应明确何时调用，减少 Agent 无意义调用。

## 13. Context Compiler

### 13.1 输入

- 用户任务文本。
- repo / branch / HEAD / changed files。
- 活跃任务与最近 session。
- 可用 Memory、Git 和可选 CodeGraph provider。
- token budget 与类型限制。

### 13.2 编译流水线

1. **Task normalization**：提取关键术语、文件、symbol、错误码和意图。
2. **Hard filtering**：project、状态、权限、scope 与 branch 过滤。
3. **Candidate recall**：FTS5 + metadata + recent task/session + relation expansion。
4. **Staleness evaluation**：检查 anchor 文件、symbol、commit distance 和 diff overlap。
5. **Ranking**：计算 relevance、importance、recency、confidence、scope match、evidence quality 与 stale penalty。
6. **Diversity / deduplication**：合并近似项，避免同一结论重复占预算。
7. **Section allocation**：按任务状态、决策、约定、坑、近期历史、文件和警告分配预算。
8. **Compression**：优先使用 summary；仅在必要时抽取完整内容中的关键句。
9. **Pack validation**：检查 token 上限、来源覆盖、冲突和 stale warning。
10. **Explainability log**：记录为何选中、降权或遗漏，供调试与 benchmark。

### 13.3 初始排序模型

v0.1 采用可解释的启发式评分，不依赖 embedding：

```text
score =
  0.30 * lexical_relevance
+ 0.16 * scope_match
+ 0.14 * task_continuity
+ 0.12 * importance
+ 0.10 * confidence
+ 0.08 * recency
+ 0.06 * evidence_quality
+ 0.04 * relation_support
- stale_penalty
- duplication_penalty
```

权重是初始假设，必须通过离线评测与真实使用反馈校准，不作为永久协议。

### 13.4 Context Pack 固定结构

```text
PROJECT CONTEXT

Current objective
Relevant decisions
Project conventions
Known pitfalls / failed approaches
Recent progress
Likely files / symbols
Next actions
Warnings / potentially stale memories
```

无内容的 section 应省略。每个重要结论附短来源标识，例如 `[M281 · commit abc123]`；Agent 可按 ID 继续调用 `memory_get`。

### 13.5 Token 预算规则

- 默认 1,000 tokens，目标区间 800–1,500。
- 预留至少 10% 给 warning 与来源标识。
- 优先级：任务状态 > 硬约束/决策 > pitfalls > 下一步 > 近期历史 > 辅助事实。
- 高风险 stale 内容不得挤掉当前已验证约束。
- 超预算时先减少数量，再缩短摘要；不得截断到语义不完整。
- 返回实际 token 估算和被省略项计数。

### 13.6 Embedding 引入门槛

只有当 benchmark 证明 FTS5 + metadata 在同义表达或跨术语检索上显著影响任务成功率，且预期收益大于索引成本、隐私复杂度与包体积成本时，才进入实验。v0.1 不默认实现 Vector DB。

## 14. Memory Extraction

### 14.1 应该记住

- 具有未来复用价值的决策及理由。
- 被测试或运行结果证明的事实。
- 失败方法、失败原因和适用范围。
- 明确的项目约定与用户偏好。
- 当前任务状态、阻塞、下一步。
- 可靠命令、环境要求与 workaround。

### 14.2 不应该记住

- Agent 的过程性寒暄和无结论思考。
- 未经确认的猜测，除非显式标为低置信候选。
- 密钥、token、密码、完整环境变量或敏感个人数据。
- 大段可从代码直接重建且没有历史价值的内容。
- 完整 transcript（除非用户显式开启诊断并设置保留期限）。

### 14.3 v0.1 提取路径

1. **显式写入**：Agent 或用户通过 `memory_record` 记录。
2. **结构化 hook 事件**：文件变化、测试摘要、Git 状态和 session lifecycle。
3. **Session finalization summary**：由当前 Agent 按 schema 产出候选，不额外依赖云模型。
4. **确定性后处理**：去重、类型校验、scope 推断、敏感信息过滤和 evidence 绑定。

### 14.4 去重与冲突

- exact content hash 去重。
- FTS + shared scope + relation 检测近似重复。
- 新内容与旧内容矛盾时不得静默覆盖；创建 `CONTRADICTS` 或 `SUPERSEDES` 关系。
- 合并必须保留原始 revision 与 evidence。
- 自动合并只允许高置信、同 scope、无冲突项，否则进入候选 review。

## 15. 陈旧检测与验证

### 15.1 陈旧信号

- 关联文件在 memory commit 后发生变化。
- 关联行区间或 symbol 消失、重命名或内容 hash 大幅改变。
- 后续 commit message / diff 与记忆主题高度相关。
- 新记忆与旧记忆矛盾或明确 supersede。
- branch scope 不匹配。
- 距离 `last_verified_at` 超过类型相关阈值。
- 用户或 Agent 提供失败反馈。

### 15.2 风险分级

- `LOW`：来源未变化或最近验证。
- `MEDIUM`：相关文件有变化，但 anchor 仍存在。
- `HIGH`：symbol 消失、相关 diff 大幅变化或存在冲突记忆。

行为：

- LOW：正常返回。
- MEDIUM：降权并附“建议验证”。
- HIGH：默认不作为肯定结论；仅在高度相关时放入 Warning。

### 15.3 验证闭环

Agent 依赖某条记忆完成任务后，可以提交正/负反馈：

- `helpful_and_correct`
- `helpful_but_stale`
- `incorrect`
- `irrelevant`

系统更新 verification、stale risk 和排序特征，但不得仅凭一次隐式正反馈把事实永久标为 verified。

## 16. Polarbear Desktop 集成

### 16.1 产品角色

Polarbear Desktop 是 **Polarbear Memory Admin Console / Developer Knowledge Browser**。

### 16.2 v0.1 Viewer 范围

- 项目概览：memory 总数、决策、pitfall、活跃任务、潜在陈旧项。
- Timeline：按 session / commit 查看事件和记忆。
- Memory 列表与详情。
- 全文搜索与类型/status/scope 筛选。
- 查看来源、证据、关系和 revision。
- verify、edit、supersede、archive、forget。
- Promote to Markdown。
- 查看最近 Context Pack 与 token 使用。

### 16.3 集成约束

- 不直接打开 `memory.db`。
- 通过版本化 SDK / local API 调用。
- Engine 不可用时展示可诊断状态，不自行创建兼容数据库。
- UI 版本可落后于 Engine，但必须通过 capability negotiation 降级。
- Desktop 崩溃、关闭或未安装不得影响 Agent 的 Memory 能力。

## 17. CLI 需求

v0.1 至少支持：

```text
polarbear-memory init
polarbear-memory doctor
polarbear-memory status
polarbear-memory savings
polarbear-memory savings reset --confirm RESET
polarbear-memory context --task "..." --budget 1000
polarbear-memory search "..."
polarbear-memory get <id>
polarbear-memory record
polarbear-memory verify <id>
polarbear-memory forget <id>
polarbear-memory promote <id>
polarbear-memory benchmark
```

要求：

- 人类可读输出与 `--json` 机器输出。
- 稳定退出码。
- 破坏性操作二次确认；自动化模式要求显式 flag。
- `doctor` 不修改状态，除非用户明确使用 `--fix`。
- 所有命令支持从子目录发现 repo root。
- `savings` 明确标记为估算值，采用“全部检索候选 baseline tokens - 实际 Context Pack tokens”的可复现口径；重置只开始新的本地测量窗口，不影响 Memory 数据。

## 18. 配置需求

`.polarbear/config.toml` 至少支持：

- `schema_version`
- `project_id` / `project_name`
- capture mode 与 enabled 状态。
- include / exclude path patterns。
- raw event retention days。
- 默认 context token budget。
- memory type enablement。
- promotion target directory。
- Git / CodeGraph provider 开关。
- privacy redaction patterns。
- adapter-specific settings。

配置原则：

- 安全默认值。
- 未知字段保留或明确报错，不静默丢失。
- schema 可迁移。
- 仓库配置不得包含 secret。

## 19. 隐私、安全与合规

### 19.1 默认策略

- 本地处理、本地存储、无遥测。
- 不上传代码、memory 或 transcript。
- 不读取 `.env`、凭据目录、密钥文件和用户排除路径。
- 默认不保存完整命令输出，只保留必要的结果摘要与 evidence reference。
- raw events 默认保留 7 天，可设为 0。

### 19.2 敏感信息防护

- 内置常见 token、私钥、密码、连接串检测。
- 支持项目级 redaction pattern。
- 写入前过滤，展示时再次防泄漏。
- 日志不得输出 memory 正文、密钥或未脱敏 hook payload。
- 导出与 Promote 前显示将写入 Git 的内容。

### 19.3 权限与信任

- MCP 写操作必须限制在当前已识别项目。
- 用户显式请求才允许永久删除。
- Adapter 安装必须展示将修改的文件与 hook。
- 不执行从 memory 内容中读取的命令；Memory 是数据，不是可信指令。
- 从外部仓库获取的 Markdown knowledge 视为不可信输入，防止 prompt injection。

## 20. 非功能需求

### 20.1 性能

- `memory_context`：本地 warm p95 < 300 ms（不含外部 CodeGraph）。
- `memory_search`：10,000 条 memory 下 p95 < 150 ms。
- 新事件写入 p95 < 50 ms，不阻塞 Agent 主流程。
- 默认 Context Pack <= 请求预算的 105%，不得无界超出。
- 增量 stale scan 不应每次全库扫描。

### 20.2 可靠性

- Agent 或 Desktop 异常退出后数据库保持一致。
- Hook 失败不得阻断用户正常退出 session。
- 写入具备幂等键，重复 hook 不产生重复 memory。
- migration 失败可恢复到备份。
- FTS 索引可重建。

### 20.3 可移植性

- v0.1：macOS 正式支持。
- 架构上不绑定 Tauri 或 Polarbear Desktop。
- 路径、进程和安装逻辑为 Windows / Linux 保留适配边界。

### 20.4 可观测性

- 本地结构化日志，可配置级别。
- 记录 retrieval explain 数据，但默认不记录敏感正文。
- `doctor` 可导出脱敏诊断包。
- 关键指标可本地查看，遥测必须单独 opt-in。

## 21. 成功指标

### 21.1 North Star

**Saved Rediscovery Cost per Resumed Task**：恢复任务时，相比 baseline 节省的重复探索 token、tool calls 和时间的组合指标。

### 21.2 v0.1 发布门槛

| 指标 | 目标 |
| --- | --- |
| 重复探索 token | 相比 baseline 降低 ≥ 40% |
| Time to first meaningful action | 中位数降低 ≥ 30% |
| 首次编辑前 file reads | 中位数降低 ≥ 30% |
| Resume task success | 不低于 baseline，目标提升 ≥ 10 个百分点 |
| Context Pack token 合规 | ≥ 99% 在预算 +5% 内 |
| 返回记忆来源覆盖 | P0 类型 100% 有 source，≥ 90% 有可检查 evidence |
| 未标记 stale 的错误记忆 | < 1% 的评测 Context Pack |
| Hook 对正常工作流阻断 | 0 个已知 P0 |
| 数据库损坏 | 0 个已知未恢复案例 |

### 21.3 Guardrail Metrics

- Wrong/stale memory exposure rate。
- Irrelevant memory rate。
- Context Pack residual token cost。
- 采集内容敏感信息命中率。
- 用户手动纠正、拒绝、forget 比例。
- Adapter 安装失败率。
- Context 调用后仍发生大范围重复探索的比例。

## 22. Benchmark 方案

### 22.1 对照设计

同一 repo、同一初始 commit、同一任务描述、同一 Agent/model 设置：

- **Baseline**：无 Polarbear Memory。
- **Treatment**：启用 Polarbear Memory，使用上一 session 产生的数据。

每个任务至少重复多次并随机化运行顺序，避免 cache、顺序与模型随机性造成偏差。

### 22.2 任务集

- 恢复未完成 bug fix。
- 解释历史架构决策。
- 避免过去失败的实现。
- 在代码已变化时识别旧结论。
- 跨 branch 判断规则适用性。
- 在信息不足时正确选择验证而不是盲信。

任务集应包含公开 fixture repo 与私有真实项目的脱敏样本。

### 22.3 指标

- Tokens before first meaningful edit。
- File reads before first edit。
- Tool calls。
- Time to first edit。
- Total tokens / cost。
- Task success 与测试通过率。
- Wrong/stale memory used。
- Context Pack tokens 与 residual context。
- 用户纠正次数。

### 22.4 通过规则

- 先满足安全 guardrail，再判断效率收益。
- 若 token 降低但任务成功率下降，不通过。
- 若平均收益由少数任务拉高，而主要场景无稳定改善，不通过。
- benchmark 报告必须披露失败样本、额外 residual context 和环境配置。

## 23. 功能优先级

### 23.1 P0 — v0.1 必须有

- SQLite schema、migration、FTS5。
- Project / session / task identity。
- Git branch、commit、file association。
- Memory CRUD、revision、source、evidence。
- Memory lifecycle 与基础 stale detection。
- `memory_context/search/get/record/verify/forget/status`。
- Token-budget Context Compiler。
- Claude Code MCP + hooks + Skill 入口。
- Session handoff / resume。
- 自动候选提取、去重、分类。
- CLI init / doctor / status / management。
- Polarbear Memory Viewer 基础能力。
- Markdown promote / export。
- benchmark harness。
- 敏感信息过滤与 raw event retention。

### 23.2 P1 — v0.2

- Codex adapter。
- Cursor adapter。
- CodeGraph provider。
- 更强的 symbol anchor 和增量 stale detection。
- Retrieval feedback 与权重校准。
- 稳定 SDK / local API 与 Desktop 深度集成。
- Context Pack explain UI。
- Linux / Windows 安装支持。

### 23.3 P2 — v0.3+

- 可选 embedding / hybrid retrieval（以 benchmark 为前提）。
- 团队知识、权限与加密同步。
- 决策 review workflow。
- 跨仓库 memory 与 dependency scope。
- CI / PR context integration。
- 托管服务与商业版本。

## 24. Roadmap

Roadmap 以退出门槛驱动，不以日期自动视为完成。下列周期是单个小型核心团队的初始估算。

### Phase 0 — Evidence & Foundations（2 周）

目标：在正式扩大范围前，证明可采集、可恢复、可衡量。

交付：

- 3–5 个 session-resume fixture。
- baseline benchmark runner。
- Memory schema v1 与 migration 框架。
- 最小 CLI：init / record / context / status。
- FTS5 + metadata retrieval PoC。
- 800–1,500 token Context Pack PoC。
- threat model 与敏感信息规则初稿。

退出门槛：

- 至少 3 个真实 resume 任务可从 session A 生成记忆，并在 session B 使用。
- 无需保存完整 transcript。
- 可重复采集 baseline 与 treatment 指标。

### Phase 1 — v0.1 Alpha: Reliable Resume（4 周）

目标：完成可供内部 daily use 的独立 Engine。

交付：

- Rust core / storage / git / CLI 基础模块。
- 完整 P0 MCP 工具合约。
- Claude Code MCP 与手动/半自动 capture。
- Memory types、revision、evidence、relations。
- 基础 dedup 与 lifecycle。
- Context Compiler v1 与 explain log。
- `doctor`、备份、恢复与 migration 测试。

退出门槛：

- 连续 20 次 session resume 无数据库损坏或工作流阻断。
- Context Pack token 合规率 ≥ 95%。
- P0 memory 全部可追溯 source。
- 内部任务的重复探索 token 中位数下降 ≥ 25%。

### Phase 2 — v0.1 Beta: Invisible Capture & Trust（4 周）

目标：把“能用”变成“无需刻意维护也可信”。

交付：

- Claude hooks 自动采集与 session finalization。
- 确定性敏感信息过滤。
- 基于 Git diff/file anchor 的 stale detection v1。
- verify / dispute / supersede / archive 流程。
- Polarbear Viewer：Overview、Timeline、Search、Detail、Review。
- Promote to Markdown。
- benchmark task suite 与报告生成。

退出门槛：

- ≥ 80% 的 resume session 无需用户手动 `/remember`。
- 高风险 stale 评测样本 100% 被警告或排除。
- Hook 不增加可感知的 session 操作延迟。
- 端到端隐私测试不写入 fixture secrets。

### Phase 3 — v0.1 GA: Benchmark & Hardening（2–3 周）

目标：达到可公开发布的质量与证据标准。

交付：

- 安装包、升级、卸载、配置备份与回滚。
- 性能、并发、crash recovery 与 migration hardening。
- 公开 benchmark methodology 和可复现 fixture。
- 文档：Quickstart、Privacy、Troubleshooting、MCP contract。
- Polarbear Desktop 兼容矩阵。

退出门槛：

- 满足第 21.2 节全部 v0.1 发布门槛。
- 至少 2 周内部 dogfood 无 P0/P1 数据安全缺陷。
- 卸载后第三方 Agent 配置可完整恢复。

### Phase 4 — v0.2: Cross-Agent & Structural Context（6–8 周）

目标：从 Claude Code resume 工具升级为跨 Agent knowledge layer。

交付：

- Codex、Cursor adapters。
- CodeGraph optional provider。
- 更稳定的 local API / SDK。
- symbol-aware stale detection。
- Context Compiler ranking v2 与 feedback calibration。
- macOS 以外平台的首批支持。

退出门槛：

- 同一记忆可在至少 3 个 Agent 间一致读写。
- CodeGraph 缺失或故障时自动降级且不影响核心流程。
- 跨 Agent benchmark 不低于单 Agent baseline。

### Phase 5 — v0.3: Team Memory（8–12 周，需单独立项）

目标：验证多人共享和商业化，而不破坏 local-first 信任。

候选交付：

- 团队 durable knowledge review。
- 加密同步、权限、审计和冲突处理。
- 组织级 convention / architecture memory。
- PR / CI 集成。
- Free / Pro 边界与可选托管能力。

进入条件：

- v0.1/v0.2 已证明个人用户留存与稳定效率收益。
- 完成独立的安全、权限、同步与合规设计。

## 25. 发布策略

1. **Developer PoC**：核心团队项目，采集完整 benchmark，不对外宣传数字。
2. **Private Alpha**：10–20 名高频 Claude Code 用户，仅 macOS。
3. **Private Beta**：50–100 名用户，重点观察 stale、隐私与自动采集误差。
4. **Public Beta**：公开安装与可复现 benchmark，明确“local-first / Claude-first”。
5. **v0.1 GA**：满足退出门槛后发布，不以功能列表完成代替质量验收。

每阶段必须提供一键暂停、导出和卸载；严重 stale 误导、secret 写入或数据损坏触发停止扩量。

## 26. 依赖与约束

### 26.1 外部依赖

- Claude Code 的 MCP 与 lifecycle hook 能力。
- Git 仓库、commit 与 diff 信息。
- SQLite / FTS5。
- Polarbear Desktop 的稳定客户端集成边界。
- CodeGraph（仅 v0.2 可选增强）。

### 26.2 产品约束

- 首版资源有限，必须优先证明 resume 的量化价值。
- 不同 Agent 的 hook 和 session event 粒度不同，Adapter 不能污染 Core 模型。
- 自动提取不可假设始终有额外模型调用预算。
- Local-first 限制了跨设备同步，但这是 v0.1 的信任优势而非缺陷。

## 27. 主要风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 错误或陈旧记忆误导 Agent | 高 | evidence、stale state、降权、warning、验证反馈、评测 guardrail |
| 自动采集产生大量噪音 | 高 | 类型白名单、候选态、去重、importance threshold、raw retention |
| 保存 secret 或敏感代码 | 高 | 默认排除、双重 redaction、无 transcript、导出预览、安全测试 |
| Context Pack 本身占用过多 token | 高 | 严格预算、progressive disclosure、section allocation、残留成本指标 |
| Agent 不调用 MCP | 中 | Skill/规则提示、SessionStart 注入、adapter 测试、doctor |
| Hooks 改坏用户配置 | 高 | dry-run、备份、幂等修改、可逆卸载 |
| SQLite 被 Desktop 与多个 Agent 并发访问 | 中 | WAL、事务、busy timeout、单写策略评估、并发测试 |
| FTS 无法召回同义语义 | 中 | 先 benchmark；必要时在 v0.2+ 引入 hybrid retrieval |
| 与原生 Agent memory 冲突或重复 | 中 | 清晰优先级、来源标签、去重、adapter 指令避免重复注入 |
| 产品被误解为聊天归档 | 中 | 以 resume、决策与 token 结果营销，不以“存更多”营销 |
| Polarbear Desktop 绑定核心发布节奏 | 中 | 独立仓库、稳定 API、Engine 单独发布、UI capability negotiation |

## 28. 验收标准（v0.1）

### 28.1 安装

- 全新 Git repo 执行 `init` 后可检测并配置 Claude Code。
- 重复执行 `init` 不产生重复配置。
- `--dry-run` 不写文件。
- 卸载或 restore 能恢复初始化前配置。

### 28.2 Capture

- 完成一次含编辑、测试失败和下一步的 session 后，生成对应类型的候选记忆。
- 不保存过程性寒暄。
- fixture secret 不进入数据库、日志或 Markdown。
- 重复 finalization 不产生重复项。

### 28.3 Resume

- 新 session 可用一句任务描述生成预算内 Context Pack。
- Pack 包含上次进度、相关决策、pitfall、下一步和来源。
- 可通过 `memory_get` 展开任意引用项。
- 无相关记忆时返回明确空结果，不生成幻觉内容。

### 28.4 Stale

- 修改关联代码后，相关记忆被重新评估。
- 高风险旧记忆不以无警告的确定事实进入 Pack。
- 用户验证后保留验证人、时间、commit 与 evidence。

### 28.5 Management

- CLI 与 Viewer 可搜索、查看、编辑、verify、supersede、archive 和 forget。
- Promote 生成可读 Markdown，并关联回原 memory。
- Desktop 不直接访问 SQLite，Engine 停止时有清晰错误。

### 28.6 Reliability

- 崩溃恢复、并发写、migration、FTS 重建和备份恢复测试通过。
- Hook / MCP 失败不阻断 Agent 正常工作。
- benchmark 可在干净环境重复运行并产出同结构报告。

## 29. 待验证假设与开放问题

以下问题不阻止 Phase 0，但必须在对应阶段前形成决策记录：

1. Claude Code session finalization 能稳定提供哪些事件和上下文？缺失时的 fallback 是什么？
2. v0.1 使用“每 Agent 一个 MCP 进程 + SQLite WAL”，还是引入常驻 local daemon？需用并发与安装复杂度实验决定。
3. 自动提取由当前 Agent 输出结构化候选，还是需要独立 extractor model？v0.1 默认前者。
4. 项目 identity 在 remote 改名、fork、worktree 和无 remote repo 中如何迁移？
5. branch-scoped memory 合并回主分支后如何自动扩大或收窄 scope？
6. symbol anchor 在多语言仓库中是否仅用文本/路径，还是提前引入 tree-sitter？
7. Polarbear Desktop v0.1 采用 CLI JSON、local socket 还是 versioned local HTTP API？
8. `forget` 的用户预期是逻辑归档、加密擦除还是物理删除及 vacuum？
9. Durable Markdown 与 operational memory 冲突时，谁拥有更高优先级？建议以显式 verified + 最近证据决定，而非按存储类型决定。
10. Benchmark 的“meaningful action”如何跨不同 Agent 统一判定？

## 30. 产品叙事与命名

底层产品名称保持 **Polarbear Memory**，首个 killer feature 可命名为 **Handoff**，但产品不被 Handoff 场景锁定。

建议对外表达：

```text
Polarbear Memory works invisibly for your AI.
Polarbear lets you see what your AI remembers.
```

首页结果导向文案：

```text
Your coding agent shouldn't rediscover your project every morning.

Polarbear remembers past decisions, failed approaches and unfinished work —
and gives your agent only the context it needs.
```

核心营销词：

- Continue instantly.
- Fewer tokens.
- Never repeat yourself.

对外 benchmark 上线前必须明确结果来自何种 repo、任务、Agent/model、重复次数与评判方式。

## 31. 最终决策摘要

- 独立仓库 `polarbear-memory` 是正确边界；不把 Engine 放入 Polarbear Desktop 仓库。
- 产品核心是 Context Compiler 和 Memory Lifecycle，不是 Handoff UI 或 Storage。
- SQLite + FTS5 是 v0.1 事实源；Markdown 是可提升、可评审的长期知识界面。
- Claude Code 是 v0.1 唯一完整 Agent；Codex、Cursor 在 v0.2。
- 不默认做 embedding；先用 benchmark 证明需求。
- Polarbear Desktop 是可选管理客户端，通过稳定接口连接，绝不直接操作数据库。
- v0.1 以“隔天直接续做”和“重复探索成本至少降低 40%”作为发布证明。
- stale memory、隐私泄漏和上下文过载是首要 guardrail，优先级高于记忆数量。
