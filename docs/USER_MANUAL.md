# Polarbear Memory 用户手册（预期体验）

> **适用产品**：Polarbear Memory
> **文档版本**：v1.0 Draft
> **文档日期**：2026-08-16
> **状态**：产品实现前的用户体验规格，用于评审；文中的命令和界面尚未发布
> **相关文档**：[PRD](./PRD.md) · [TRD](./TRD.md)

---

## 1. 先看结论

Polarbear Memory 的理想使用方式是：安装一次，然后正常使用 AI 编程 Agent。

你不需要在每次 session 结束时手动整理 handoff，也不需要每天重新解释项目背景。Polarbear Memory 会把值得复用的决策、失败经验、约定、任务进度和下一步保存在本地，并在新 session 开始时只提供当前任务真正需要的部分。

```text
第一天
你和 Agent 编码、测试、调整方案
             │
             ▼
Polarbear Memory 提取有价值的项目记忆

第二天
你说“继续昨天的 redemption 问题”
             │
             ▼
Agent 获得短 Context Pack，直接继续工作
```

默认体验目标：

- 不保存完整聊天记录。
- 不把全部历史塞进 Agent prompt。
- 不主动上传项目数据。
- 不要求安装 Polarbear Desktop。
- 不依赖 CodeGraph。
- 不允许 Agent 静默物理删除记忆。
- 代码变化后，旧记忆会提示可能已经过期。

## 2. 这份手册描述的是什么

产品尚未实现，因此本手册描述的是经过 PRD/TRD 约束的**目标用户体验**。它用于在写代码前确认：

- 安装步骤是否合理。
- 自动化程度是否符合预期。
- 用户是否仍然拥有足够控制权。
- CLI、Agent 和 Polarbear Desktop 的分工是否自然。
- 隐私、安全和删除语义是否可接受。

最终命令参数和界面文字可以在开发中微调，但核心流程和权限边界不能在没有评审的情况下改变。

## 3. 功能何时可用

每个 MVP 都是独立可运行的最小版本。

| 版本 | 用户能做什么 | 主要验证 |
| --- | --- | --- |
| MVP-0 / v0.0.1 | 用 CLI 手动记录和检索 Memory | FTS + Context Pack 是否有价值 |
| MVP-1 / v0.0.2 | Claude Code 通过 MCP 使用 Memory | 新 session 是否更快进入工作 |
| MVP-2 / v0.0.3 | session 结束时自动形成 handoff | 是否可以不手动 `/remember` |
| MVP-3 / v0.0.4 | 识别 potentially stale Memory | 旧记忆是否会误导 Agent |
| MVP-4 / v0.0.5 | 在 Polarbear Desktop 完整管理 Memory | 可视化是否提高信任和纠错效率 |
| v0.1 GA | 安装、升级、恢复、benchmark 和安全发布完整 | 是否可公开稳定使用 |
| v0.2 | Codex、Cursor、可选 CodeGraph | 跨 Agent Memory 是否成立 |

本手册描述 v0.1 release candidate 的完整目标体验，并在涉及后续能力时明确标注。只有 [GA Readiness](GA_READINESS.md) 中的真实 Agent benchmark、两周 dogfood、签名/公证和许可证 blocker 全部关闭后，才可改称正式 GA。

## 4. 核心概念

### 4.1 Memory

Memory 是一条未来可能复用的工程知识，不是一段聊天记录。

例如：

```text
Type: DECISION
Summary: FAILED 被设计为终态。
Reason: 重试可能造成重复结算。
Scope: settlement module
Source: session 2026-08-15 / commit abc123
Status: ACTIVE
```

### 4.2 Context Pack

Context Pack 是针对当前任务编译的短上下文，通常控制在 800–1,500 tokens。

它不是所有 Memory 的汇总，而是当前任务需要的“地图”：

```text
PROJECT CONTEXT

Current objective
- Fix redemption rounding discrepancy.

Relevant decisions
- PX is the source of truth for final stock quantity. [M102]

Known pitfalls
- Dealer-side recalculation caused precision drift. [M281]

Recent progress
- Recovery test still needs to be added. [M305]

Warnings
- M281 predates the latest change to RedemptionService.
  Verify before relying on it.
```

Agent 需要详细信息时，再按 ID 展开单条 Memory。

### 4.3 Operational Memory 与 Durable Knowledge

```text
Operational Memory
SQLite 中的高频、机器查询记忆

Durable Knowledge
提升到 .polarbear/knowledge/ 的 Markdown 文档
```

SQLite 由 Memory Engine 管理；用户和 Polarbear Desktop 不直接执行 SQL。长期决策可以提升为 Markdown，进入 Git review。

### 4.4 Memory 状态

| 状态 | 用户含义 |
| --- | --- |
| `CANDIDATE` | 刚提取，尚未确认是否值得长期使用 |
| `ACTIVE` | 可正常参与检索 |
| `POTENTIALLY_STALE` | 来源代码变化，需要验证 |
| `SUPERSEDED` | 已被新决策替代 |
| `ARCHIVED` | 暂不使用，但保留历史 |
| `REJECTED` | 错误或无价值候选 |

验证状态单独存在：`UNVERIFIED / VERIFIED / DISPUTED`。一条 verified Memory 仍可能因为代码变化而变 stale。

Memory 不会因为 session 增加而无限进入活跃上下文。系统从四个层次持续治理：

1. 来源变化时标记 stale，避免继续当成确定事实。
2. 新结论 supersede 旧结论，默认只提供当前结论。
3. 已完成任务、失效 scope 和长期无效候选逐渐退出默认 Context Pack。
4. 短期事件按保留期清理；canonical Memory 只自动归档，不静默物理删除。

不同类型采用不同策略：完成的 `TASK_STATE/TODO` 很快退出上下文，而 `DECISION/ARCHITECTURE/PITFALL` 不会仅因时间久被自动删除。

## 5. 安装前要求

v0.1 GA 目标支持：

- macOS。
- 本地 Git 仓库。
- Claude Code。

用户不需要：

- 预装 Node.js；正式发行包自带固定 Node runtime。
- 安装 Polarbear Desktop。
- 注册 Polarbear 账户。
- 配置云数据库、embedding API 或 LLM API key。
- 安装 CodeGraph。

Codex、Cursor、Linux 和 Windows 计划在 v0.2 支持。

## 6. 安装

目标安装方式：

```bash
brew install polarbear-memory
```

也可以从官方 release 下载经过签名的平台包。安装完成后检查：

```bash
polarbear-memory --version
polarbear-memory doctor
```

预期输出：

```text
Polarbear Memory 0.1.x

Runtime      OK
Data dir     OK
SQLite       OK
FTS5         OK
Git          OK
Network      disabled by policy
```

`doctor` 默认只检查，不修改任何配置。只有用户明确选择修复时才执行变更。

## 7. 初始化一个项目

进入项目目录：

```bash
cd my-project
polarbear-memory init
```

初始化前，CLI 展示准备进行的操作：

```text
Repository detected: my-project
Branch: main
HEAD: abc1234

Agent detected:
✓ Claude Code

Planned changes:
- Create .polarbear/config.toml
- Register Polarbear Memory MCP server
- Install session lifecycle hooks
- Add minimal Memory usage instruction

Existing Agent configuration will be backed up.

Continue? [y/N]
```

如果只想预览：

```bash
polarbear-memory init --dry-run
```

成功后：

```text
✓ Project identity created
✓ Local memory store initialized
✓ Claude Code MCP configured
✓ Claude Code hooks configured
✓ Configuration backup created

Polarbear Memory is ready.
Restart Claude Code to begin.
```

### 7.1 初始化会创建什么

项目仓库中：

```text
.polarbear/
  config.toml
  knowledge/        # 首次 Promote 时创建
```

用户数据目录中：

```text
Polarbear Memory/
  projects/<project-id>/
    memory.db
    backups/
    diagnostics/
    spool/
```

`memory.db` 不进入 Git。仓库中只有配置和用户明确提升的 Markdown knowledge。

### 7.2 初始化不会做什么

- 不读取或上传整个仓库。
- 不执行 `git fetch`、`pull` 或 `push`。
- 不保存 Git remote 中可能存在的凭据。
- 不安装在线渲染器。
- 不开启遥测。
- 不修改全局 Git 配置。

## 8. 第一次使用

初始化后的第一次 session 通常没有历史 Memory。

你正常启动 Claude Code：

```text
> Fix the redemption precision bug.
```

Agent 会先询问 Polarbear Memory。因为这是第一次使用，Memory 返回：

```text
No relevant project memory found.
Continue with normal repository exploration.
```

这不是错误。Agent 按正常方式读取代码、运行测试和完成任务。

session 期间，Polarbear Memory 只接收允许的结构化事件，例如：

- 修改了哪些项目内文件。
- Git branch 和 HEAD。
- 测试成功或失败的短摘要。
- Agent 明确形成的决策、失败原因和下一步。

它不会把“我先看看”“正在检查”等过程话术保存为 Memory。

## 9. Session 结束时发生什么

从 MVP-2 开始，用户不需要执行保存命令。

session 结束时：

```text
结构化事件
    +
Agent finalization summary
    │
    ▼
本地 validation 与 secret redaction
    │
    ▼
dedup / classify / evidence binding
    │
    ▼
Memory candidates + task state
```

可能产生：

```text
DECISION
Final stock quantity must come from PX.

PITFALL
Dealer-side recalculation introduces rounding drift.

TASK_STATE
Redemption calculation is fixed; recovery test remains.

TODO
Add recovery coverage for terminal settlement state.
```

默认不弹出打断用户的确认框。低置信内容进入 `CANDIDATE`，不会伪装成已验证事实。

MVP-3 中，Agent 可以用显式标记声明短期事项已经结束：

```text
Task state: [completed] Recovery endpoint shipped.
Next step: [cancelled] Remove the obsolete compatibility test.
```

只有 `[completed]` / `[cancelled]`（也支持 `[已完成]` / `[已取消]`）会触发完成状态；系统不会根据“看起来像做完了”自行猜测。完成项立即退出普通 Context，七天后才会被可逆归档。

用户可预览和执行本地治理：

```bash
polarbear-memory maintain --dry-run
polarbear-memory maintain
polarbear-memory complete MEMORY_ID --result completed --reason "Tests passed"
polarbear-memory restore MEMORY_ID --reason "Need historical review"
```

`maintain --dry-run` 与正式执行使用同一计划。自动维护可以删除到期 Raw Event，但 canonical Memory 最多进入 `ARCHIVED`，不会被物理删除。

## 10. 第二天继续工作

重新启动 Claude Code，直接说：

```text
> 继续昨天的 redemption 问题。
```

Agent 在广泛 grep/read 前调用 Memory，收到 Context Pack：

```text
PROJECT CONTEXT

Current objective
- Complete the redemption precision fix.

Relevant decisions
- PX owns the final stock quantity; Dealer must not recalculate it. [M12]

Known pitfalls
- Dealer recalculation previously produced precision drift. [M15]

Recent progress
- Calculation change is complete.
- Recovery test is still missing. [M18]

Likely files
- src/redemption/RedemptionService.ts
- tests/redemption/recovery.test.ts

Next action
- Add recovery test and run the redemption test suite.
```

Agent 可以直接从测试开始，不必重新读取十几个文件来重建昨天的结论。

如果 Agent 需要完整理由，它调用单条 Memory：

```text
memory_get(M12)
```

用户通常不需要看到这些工具调用，只需要看到 Agent 已正确理解上下文。

## 11. 用户可以怎样与 Memory 交互

### 11.1 正常对话

你不需要学习特殊命令，可以直接说：

```text
继续昨天的工作。

为什么这里不能 retry？

我们以前试过这个方案吗？

这个 rounding 规则现在还有效吗？

记住：这个项目所有金额都必须使用 BigDecimal。

上一条结论已经失效，新规则以 SettlementPolicy 为准。
```

Agent 根据需要使用 Memory 工具。

### 11.2 默认 Agent 工具

为了避免 Agent 面对过多工具，默认只展示：

| 工具 | 什么时候使用 |
| --- | --- |
| `memory_context` | 开始或切换任务时获取短上下文 |
| `memory_get` | 展开某条 Memory 的内容和证据 |
| `memory_search` | 用户询问历史、理由或失败经验时搜索 |
| `memory_record` | 用户明确要求记住，或形成高价值知识时记录 |
| `memory_verify` | 当前代码证明某条 Memory 正确、错误或已改变时使用 |

`memory_status` 属于诊断能力，默认按需启用。`memory_forget` 不默认提供给 Agent，而由 Human CLI 或 Polarbear Desktop 执行。

### 11.3 手动记录

即使自动 capture 尚未上线，或者你希望明确记录一条知识，也可以使用 CLI：

```bash
polarbear-memory record
```

CLI 以交互方式询问：

```text
Type: DECISION
Summary: FAILED is a terminal settlement state.
Reason: Retrying may duplicate settlement.
Scope: settlement module
Related files: src/settlement/SettlementService.ts
Evidence: test/commit/note
```

也可以让 Agent 记录：

```text
> 记住这个决定，并关联当前测试和 SettlementService。
```

## 12. 查看项目状态

```bash
polarbear-memory status
```

预期输出：

```text
Project: phoenix-issuer
Branch: main

Memories             382
Active               341
Candidates            18
Potentially stale      6
Verified              74
Active tasks           2

Last capture: 12 minutes ago
Last context: 842 estimated tokens
Database: healthy
```

状态命令用于观察系统，不会触发采集、迁移或修复。

## 13. 搜索和查看 Memory

搜索：

```bash
polarbear-memory search "FAILED terminal"
```

预期结果：

```text
M102  DECISION  ACTIVE  VERIFIED
FAILED is a terminal settlement state.
Source: session 2026-08-15 · commit abc123

M087  FAILURE  SUPERSEDED
Retry implementation caused duplicate settlement in recovery test.
Source: session 2026-07-20 · commit 98def0
```

查看详情：

```bash
polarbear-memory get M102
```

详情包括：

- 正文和摘要。
- 类型、scope、状态和置信度。
- 来源 session、commit、文件和 symbol。
- evidence。
- revision history。
- supports、contradicts、supersedes 等关系。
- 最近一次 stale 检查结果。

## 14. 当 Memory 可能过期

假设三个月前记住：

```text
Redemption uses DOWN(3) and then UP(2).
```

后来相关代码发生显著变化。系统不会继续把旧结论当成确定事实，而是显示：

```text
WARNING — potentially stale memory [M281]

The recorded rounding strategy predates commit def456.
RedemptionService changed and the original code fingerprint no longer matches.

Verify against current code before relying on this memory.
```

Agent 应先检查当前实现，再决定：

- 验证它仍然有效。
- 更新 Memory。
- 标记 disputed。
- 创建新 Memory 并 supersede 旧 Memory。

### 14.1 手动验证

```bash
polarbear-memory verify M281
```

CLI 要求填写：

- 验证结果。
- 当前 commit。
- 依据。
- 是否需要修改摘要或 scope。

“Verified”不是永久状态；以后代码再次变化，仍然可以重新变 stale。

## 15. 修改、归档和删除

### 15.1 修改

修改 Memory 会创建 revision，不覆盖历史。旧内容、修改人、时间和理由仍可查看。

### 15.2 Archive

Archive 表示“不再参与正常检索，但保留历史”。适合：

- 已完成的临时任务状态。
- 不再适用但仍有历史价值的 workaround。
- 用户暂时不想看到的候选。

### 15.3 Supersede

当新决策替代旧决策时使用。系统保留两条 Memory 及关系：

```text
M102 SUPERSEDES M087
```

这样仍能回答“以前为什么这样做，后来为什么改变”。

### 15.4 Forget 与 Purge

Agent 不能静默物理删除 Memory。

- `forget`：默认归档或创建删除请求。
- `purge`：永久删除正文、revision 和相关证据，需要用户在 Human CLI 或 Polarbear Desktop 明确确认。

即使执行 purge，SSD、文件系统快照和历史备份中也可能仍有副本，产品不会声称可以保证物理不可恢复。

## 16. Promote 为 Markdown 知识

当一条 Memory 被确认长期有效，可以提升为 Durable Knowledge：

```bash
polarbear-memory promote M102
```

目标文件例如：

```text
.polarbear/knowledge/decisions/failed-terminal-state.md
```

生成内容示例：

```markdown
---
format_version: 1
memory_id: M102
scope: settlement
status: verified
---

# FAILED is a terminal settlement state

## Decision

FAILED must not be retried as a normal settlement transition.

## Reason

Retrying can duplicate ledger and wallet settlement.

## Evidence

- Commit: abc123
- Test: settlement_recovery_prevents_duplicate
```

Promote 前必须预览将写入 Git 的内容。Markdown 可以由人类编辑和 review；再次导入时生成 Memory revision，不直接覆盖 operational evidence。

## 17. Polarbear Desktop 管理体验（MVP-4）

Polarbear Desktop 不是使用 Memory 的前置条件，而是完整管理控制面。

v0.0.5 的可运行入口是在打开 Git 工作区后点击侧边栏的“记忆 / Memory”按钮。首次请求时 Desktop 的 Rust 后端会连接本机 Memory Engine；如果 Engine 未运行，会尝试执行 `polarbear-memory service run`。源码开发时若命令不在 `PATH`，设置 `POLARBEAR_MEMORY_COMMAND` 为构建后的 launcher 路径。

打开一个已经初始化的项目后，首版面板提供：

```text
Memory
├── Overview counts
├── Timeline / Search / lifecycle filters
├── Detail / Verify / Dispute / Archive / Restore
├── Context Pack Explain
└── Promote preview / Confirm
```

### 17.1 Overview

v0.0.5 显示：

- Memory 总量和类型分布。
- 活跃与待复核数量。
- 按更新时间倒序的 Timeline。
- 搜索和 lifecycle filter。

类型分布、上次 capture、adapter/storage health 是后续 Overview 增量，不应由 Desktop 直接查询 SQLite 补齐。

### 17.2 Memory Detail

v0.0.5 可以：

- 查看惰性纯文本内容、来源类型、commit/branch、关联文件、file anchor、最新 lifecycle assessment、关系和 revision audit。
- verify、dispute、archive、restore。
- 使用明确 reason 建立 `SUPERSEDES` / `CONTRADICTS` 关系。
- Promote to Markdown。

当前 UI 不提供直接编辑正文或物理删除；Memory 内容修改仍应通过 versioned Engine API 形成 revision，purge 继续保留为独立高风险能力。

### 17.3 Context Pack Explain

用户输入当前任务后可以查看：

- 被选中的 Memory ID 和 warning Memory ID。
- 最终惰性 Markdown source、估算 token 和选中数量。

逐条 ranking reason、被预算排除项和 Provider 贡献解释是下一版 explain DTO 的增量。

### 17.4 Engine 管理

Desktop 通过 Admin API 1.1 提供：

- Engine/API/schema/runtime/platform diagnostics；诊断结果不包含数据库路径或 Memory 正文。
- maintenance dry-run 预览，并在第二次明确操作后执行。
- 创建一致性 SQLite 备份、列出备份并重新校验 integrity/SHA-256。

数据库恢复暂时仍使用 Human CLI 的双阶段确认。原因是恢复需要进一步完成跨 MCP、CLI 和 Desktop writer 的 maintenance lock；在此之前不把已知的多进程一致性风险开放成 UI 按钮。

### 17.5 Desktop 与 Engine 的关系

```text
Polarbear Desktop
       │
完整 Admin API / SDK
       │
Memory Engine
       │
memory.db
```

Desktop 能管理全部 Memory 能力，但不直接执行 SQL。Engine 未运行时，Desktop 可以启动兼容的本地 sidecar，再通过 Admin API 工作。

关闭或卸载 Polarbear Desktop 后，CLI、MCP 和自动 capture 仍然正常。

## 18. Capture 与隐私设置

### 18.1 Capture Mode

| 模式 | 行为 |
| --- | --- |
| `off` | 不采集新内容，仍可查询已有 Memory |
| `manual` | 只接受显式 record |
| `summary` | 默认；采集结构化 session summary 和有限事件 |
| `diagnostic` | 临时采集更多脱敏信息，必须设置过期时间 |

不提供无期限 full transcript 模式。

### 18.2 默认不会记录

- `.env` 内容。
- API token、密码、private key。
- 完整环境变量列表。
- 完整 command stdout/stderr。
- Agent 的全部聊天过程。
- 项目外文件。
- 在线页面或远端图片内容。

### 18.3 Raw Event 保留

默认保留 7 天，用于完成提取和排查 ingestion 问题。可以设置为 0，在 finalization 后立即删除。

### 18.4 网络

v0.1 Runtime 的目标行为是零主动外联：

- 不调用云 embedding。
- 不调用外部 LLM API。
- 不发送遥测。
- 不自动检查更新。
- 不访问远程 PlantUML renderer。
- 不加载 Markdown 中的远端图片或 include。

安装和更新仍需要 Homebrew 或浏览器访问官方 release；这与 Runtime 处理项目数据是两个边界。

## 19. 配置

项目配置示例：

```toml
schema_version = 1
project_id = "generated-project-id"
capture_mode = "summary"
raw_event_retention_days = 7
default_context_budget = 1000

[paths]
include = ["**"]
exclude = [".env*", "**/secrets/**", "**/.git/**"]

[knowledge]
directory = ".polarbear/knowledge"

[security]
network = "disabled"
remote_resources = "deny"

[providers.git]
enabled = true
allow_remote_operations = false
```

安全相关能力不能仅通过仓库配置扩大。例如，别人提交的 `config.toml` 不能自行开启网络、读取 repo 外路径或启动任意程序。

## 20. CodeGraph 是可选的（v0.2）

Polarbear Memory 不复制 CodeGraph。

```text
Polarbear Memory
WHY / HISTORY / STATE / EXPERIENCE / NEXT

CodeGraph
WHERE / SYMBOL / CALL GRAPH / STRUCTURE / IMPACT
```

未安装 CodeGraph：

```text
memory_context = Memory + Git
```

安装并显式启用兼容的 CodeGraph：

```text
memory_context = Memory + Git + optional structural context
```

CodeGraph 不可用、版本不兼容或查询失败时，Memory 自动退化到 Memory + Git，不影响 session resume。

用户不会在 Polarbear Memory 中看到重复的 `memory_callers`、`memory_callees` 等工具。需要详细代码图谱时，Agent 直接使用 CodeGraph 自己的工具。

## 21. 跨 Agent 使用（v0.2）

目标体验：

```text
Monday
Claude Code 记录一个失败方法和架构决策

Tuesday
Codex 通过同一 Memory Engine 获得这些上下文

Wednesday
Cursor 验证代码已经变化，将旧 Memory 标为 stale
```

所有 Agent 使用同一数据库和 lifecycle policy，但不同 Adapter 只处理各自的配置与 session event。

用户可以分别启用或停用某个 Agent adapter，不影响其他 Agent。

## 22. Benchmark

用户可以运行：

```bash
polarbear-memory benchmark
```

它比较同一任务在 baseline 和启用 Memory 时的表现：

- 首次有效修改前 tokens。
- file reads。
- tool calls。
- time to first edit。
- total tokens。
- task success。
- 是否使用了错误或 stale Memory。

Benchmark 不上传数据。报告必须同时展示收益、失败样本和 Context Pack 自身占用的 tokens。

## 23. 常见问题排查

### 23.1 Agent 没有使用 Memory

运行：

```bash
polarbear-memory doctor
polarbear-memory status
```

检查：

- 项目是否初始化。
- Agent 是否重启。
- MCP 配置是否存在且指向正确 launcher。
- hooks 是否安装。
- 当前目录是否属于已初始化项目。

`doctor` 可以给出修复建议，但不会未经确认改写配置。

### 23.2 Context Pack 是空的

可能原因：

- 项目第一次使用。
- query 与已有 Memory 无关。
- Memory 都已 archive/supersede。
- branch/scope 不匹配。
- capture mode 为 off/manual，但尚未记录内容。

可以先运行：

```bash
polarbear-memory search "关键术语"
polarbear-memory status
```

### 23.3 Context Pack 返回了旧结论

- 查看 Memory 详情和 source commit。
- 检查是否已有 stale warning。
- 对当前代码完成验证。
- 使用 verify/dispute/supersede 更新，而不是直接覆盖历史。
- 如果 HIGH stale 未被警告，应作为产品缺陷报告。

### 23.4 Hook 失败

Hook 失败不应阻止 Agent 正常工作。事件可能进入本地 spool，稍后重放。`status` 会显示 pending ingestion。

### 23.5 Database busy

短暂 busy 会自动重试。持续发生时运行 `doctor`，检查：

- 是否有多个不兼容版本 Engine。
- 数据目录是否位于网络文件系统。
- 是否有程序直接打开或复制 `memory.db`。

不要用 SQLite GUI 修改数据库。

### 23.6 Polarbear Desktop 显示 Engine 版本不兼容

Desktop 应显示当前 Engine/API version 和支持范围。升级 Engine 或 Desktop 后重试；Desktop 不应绕过版本检查直接读取数据库。

### 23.7 怀疑发生了网络请求

停止 capture，运行 diagnostics，并检查本地审计日志。Runtime 对 PlantUML、远程图片、Markdown include 和外部 provider 的意外访问都属于安全问题。

## 24. 备份与恢复

备份必须由 Memory Engine 执行，不能在数据库运行时直接复制 `memory.db`。

Polarbear Desktop 或 Human CLI 可以：

- 创建一致性备份。
- 查看备份时间、schema version 和 checksum。
- 在恢复前运行兼容性检查。
- 恢复失败时保留原数据库。

Promoted Markdown 已进入 Git 时，可以通过 Git 单独恢复；它不等于 operational database 的完整备份。

v0.1 CLI：

```bash
polarbear-memory backup create
polarbear-memory backup list
polarbear-memory backup verify BACKUP.db
polarbear-memory backup restore BACKUP.db
# 阅读预览后，以输出的精确文件名确认
polarbear-memory backup restore BACKUP.db --confirm BACKUP.db
```

`list/verify` 显示 schema、大小、SHA-256 与 SQLite integrity。恢复会先验证候选，替换前 checkpoint 当前数据库，并把旧数据库保留为 `pre-restore-*.db` rollback。

## 25. 暂停、卸载和保留数据

v0.1 可先运行 `polarbear-memory uninstall --dry-run` 查看会移除的受管 MCP、hooks 和 rule。默认卸载语义等同 `--keep-data`：只解除 Agent 集成，保留数据库、备份与 Durable Knowledge。

### 25.1 暂停 Capture

将 capture mode 设置为 `off`。已有 Memory 仍可查询，Agent 不再产生新候选。

### 25.2 从当前项目移除 Agent 集成

卸载流程必须：

- 展示将修改的 Agent 配置。
- 在修改前保存当前配置 backup。
- 只移除 Polarbear Memory 自己管理的 MCP entry、hooks 和未被修改的 rule。
- 用户修改过的 rule 保留并明确报告。
- 不删除用户其他 MCP 或 hook 配置。

### 25.3 卸载并保留数据

目标命令：

```bash
polarbear-memory uninstall --keep-data
```

它移除 CLI/Agent 集成，但保留数据库和 Durable Knowledge，方便以后重新安装。

### 25.4 删除全部数据

这是独立的高风险操作，必须列出影响范围并以 project UUID 确认。v0.1 不直接永久删除，而是把项目数据目录移动到当前用户的 recoverable trash：

- 涉及的项目。
- operational database。
- backups。
- raw events 和 diagnostics。
- 是否保留 `.polarbear/knowledge` Markdown。

用户明确确认后才执行。

## 26. 常见问题

### 必须安装 Polarbear Desktop 吗？

不需要。CLI、MCP、hooks 和 Memory Engine 可以独立工作。

### Desktop 能完全管理 Memory 吗？

架构目标是能，而且始终通过完整 Admin API，不直接执行 SQL。当前 v0.1 Desktop 已覆盖浏览、搜索、来源/evidence/revision、关系、验证/争议、可恢复归档/恢复、Context Explain、maintenance、diagnostics、一致性备份和 Promote。数据库恢复、安全卸载与 purge approval 仍由 Human CLI 承担；配置编辑和跨进程 restore lock 是剩余的 versioned capability。

### 用户需要安装 Node.js 吗？

正式发行版不需要。平台包捆绑经过验证的 Node runtime。

### Memory 会上传代码吗？

v0.1 不会主动上传项目数据，也不依赖云服务。

### Memory 会保存完整聊天吗？

默认不会。只保存未来可能复用的结构化知识和短期脱敏事件。

### Memory 会自动执行记录下来的命令吗？

不会。`COMMAND` 也是不可信数据，仅供参考。

### Memory 会越来越占 prompt 吗？

不会按总量注入。Context Compiler 受到 token budget 限制，只返回与当前任务相关的摘要。

### 可以直接编辑 `memory.db` 吗？

不建议，也不受支持。请使用 CLI、MCP 或 Polarbear Desktop Admin API。

### 没有 CodeGraph 能用吗？

可以。CodeGraph 是 v0.2 的可选增强，不是依赖。

### Agent 记错了怎么办？

可以 verify、dispute、supersede、archive 或 purge；所有修改保留来源和 revision。

## 27. 一条完整用户旅程

```text
1. 安装
   brew install polarbear-memory

2. 初始化
   cd phoenix-issuer
   polarbear-memory init

3. 第一天使用 Claude Code
   “Fix redemption precision bug”
   Agent 修改代码、运行测试、形成决策

4. 自动 Handoff
   Session 结束，Memory 提取 decision、pitfall、task state、TODO

5. 第二天继续
   “继续昨天的 redemption 问题”
   Agent 先获得 800–1,500 token Context Pack

6. 代码变化
   旧 rounding Memory 被标记 potentially stale

7. 用户审阅
   在 Polarbear Desktop 查看来源和 diff，确认新规则

8. 长期沉淀
   Promote 为 .polarbear/knowledge/decisions/redemption-rounding.md

9. 换 Agent
   Codex 在 v0.2 通过同一 Engine 使用这条知识
```

## 28. 本轮评审清单

请重点判断以下体验是否符合预期：

- [ ] 安装只需一次，并在修改 Agent 配置前展示 diff 和创建 backup。
- [ ] 第一次 session 没有 Memory 时正常退化，不影响 Agent 工作。
- [ ] 从 MVP-2 开始，正常使用不需要 `/remember` 或 `/handoff`。
- [ ] 默认只保存结构化知识，不保存完整聊天。
- [ ] 新 session 自动先取短 Context Pack，而不是全量历史。
- [ ] Agent 默认只看到 5 个 Memory 工具。
- [ ] `status` 和 `forget` 主要属于 Human/Admin 管理能力。
- [ ] Agent 不能执行物理 purge。
- [ ] 代码变化后，旧 Memory 会降权并警告。
- [ ] Polarbear Desktop 是完整 Admin Console，但不是 Engine 的运行依赖。
- [ ] 用户正式使用不需要安装 Node.js。
- [ ] v0.1 默认零主动外联，无云模型、遥测或远程 PlantUML。
- [ ] CodeGraph 是 v0.2 可选 Provider，不安装也能完整使用核心功能。
- [ ] 每个 MVP 都能独立运行和决定是否继续投入。

如果以上体验被接受，它将成为后续实现和验收测试的用户侧基线。
