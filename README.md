# Polarbear Memory

Polarbear Memory 是面向 AI 编程 Agent 的本地长期记忆引擎。

它把项目中值得复用的决策、失败经验、任务进度和下一步保存在本地；当你开始新 session 或切换任务时，Agent 只取回当前任务需要的短 Context Pack，而不是重新扫描全部历史或把所有记忆塞进 prompt。

```text
开发过程中
  决策 / 踩坑 / 当前进度 / TODO
                 │
                 ▼
        Polarbear Memory（本地）
                 │
                 ▼
新 session → 与当前任务相关的 Context Pack → Agent 继续工作
```

## 能做什么

- **项目长期记忆**：记录 `DECISION`、`PITFALL`、`TASK_STATE` 和 `TODO`。
- **按任务提供上下文**：根据任务和 token budget 编译短 Context Pack。
- **MCP 集成**：Agent 可以搜索、读取、记录和验证 Memory。
- **自动 handoff**：Claude Code session 结束时，本地提取明确标记的决策、踩坑、进度和下一步。
- **过期治理**：结合代码来源变化、替代关系、任务完成状态和保留策略，让旧知识退出默认上下文，避免 Memory 无意义增长。
- **可验证、可撤销**：支持 verified/disputed、归档/恢复、备份/恢复和审计记录。
- **Token 节省估算**：统计 Context Compiler 相对候选上下文基线减少的估算 token。
- **Local-first**：SQLite 数据由 Memory Engine 保存在当前用户的数据目录，不需要云数据库或模型 API Key。

Polarbear Memory 保存的是可复用工程知识，不是完整聊天记录。Memory 会被当作不可信项目数据，不会作为可执行指令处理。

## 环境要求

- Node.js `>=24.10.0 <27`
- npm
- Git 仓库

## 安装

推荐全局安装，以便 MCP 客户端和 lifecycle hook 都能从 `PATH` 找到命令：

```bash
npm install --global polarbear-memory
```

验证安装：

```bash
polarbear-memory --version
polarbear-memory --help
```

升级：

```bash
npm install --global polarbear-memory@latest
```

## 快速开始

### 1. 初始化 Git 项目

进入需要使用 Memory 的仓库：

```bash
cd /path/to/your-project

# 可选：先预览，不修改文件
polarbear-memory init --dry-run

# 初始化
polarbear-memory init
```

初始化会在仓库中创建 `.polarbear/config.toml`。`memory.db` 不放进项目仓库，而是由 Memory Engine 保存在操作系统的当前用户数据目录。

### 2. 启用 Claude Code MCP

自动配置前先预览：

```bash
polarbear-memory claude install --dry-run
```

确认后安装：

```bash
polarbear-memory claude install
```

该命令会合并或创建：

- `.mcp.json`：注册 Polarbear Memory MCP stdio server。
- `.claude/rules/polarbear-memory.md`：告诉 Agent 何时读取、记录和验证 Memory。
- `.claude/settings.json`：安装 `Stop` 与 `SessionEnd` 本地 handoff hooks。

已有文件会先备份。安装后重新启动 Claude Code，并在首次提示时批准项目 MCP server。

如果需要撤销刚才的集成修改：

```bash
polarbear-memory claude restore
```

### 3. 开始使用

正常和 Agent 对话即可，例如：

```text
继续上次 settlement retry 的工作。

我们以前为什么决定不在 transaction 里面 retry？

记住：FAILED 是终态，重试可能造成重复结算。

检查之前关于 RedemptionService 的结论现在是否仍然成立。
```

Agent 会按需调用 Memory MCP 工具。你不需要在每个 session 结束时手工整理完整 handoff。

## MCP 配置

### Claude Code：推荐自动配置

```bash
cd /path/to/your-project
polarbear-memory init
polarbear-memory claude install
```

生成的 MCP 配置等价于：

```json
{
  "mcpServers": {
    "polarbear-memory": {
      "type": "stdio",
      "command": "polarbear-memory",
      "args": [
        "mcp",
        "--stdio",
        "--project-root",
        "${CLAUDE_PROJECT_DIR:-.}"
      ]
    }
  }
}
```

### 其他 MCP 客户端：手动配置

先在目标 Git 仓库运行一次 `polarbear-memory init`，然后把下面的 stdio server 加入客户端配置：

```json
{
  "mcpServers": {
    "polarbear-memory": {
      "command": "polarbear-memory",
      "args": [
        "mcp",
        "--stdio",
        "--project-root",
        "/absolute/path/to/your-project"
      ]
    }
  }
}
```

`polarbear-memory mcp --stdio` 是由 MCP 客户端启动的长驻 stdio 进程，通常不需要在终端中手动运行。

### 默认 MCP 工具

| 工具 | 用途 |
| --- | --- |
| `memory_context` | session 开始或切换任务时，获取预算内的相关 Context Pack |
| `memory_search` | 搜索历史决策、失败经验、任务状态或 TODO |
| `memory_get` | 按 ID 展开一条 Memory 的内容、状态和来源 |
| `memory_record` | 记录值得复用的工程知识 |
| `memory_verify` | 根据当前代码或证据验证、质疑一条 Memory |

默认不把管理操作交给 Agent。确实需要时，可以在 MCP 参数中增加 `--admin-tools`，额外开放：

| 工具 | 用途 |
| --- | --- |
| `memory_status` | 查看当前项目 Memory 数量和状态 |
| `memory_forget` | 将 Memory 可撤销地归档；不会物理删除 |

示例：

```json
{
  "command": "polarbear-memory",
  "args": [
    "mcp",
    "--stdio",
    "--admin-tools",
    "--project-root",
    "/absolute/path/to/your-project"
  ]
}
```

## CLI 使用

### 记录 Memory

```bash
polarbear-memory record \
  --type DECISION \
  --summary "FAILED is a terminal settlement state" \
  --content "Retrying inside the transaction may duplicate settlement" \
  --file src/settlement/SettlementService.ts
```

支持的类型：

- `DECISION`：已经形成的工程决策。
- `PITFALL`：失败方案、风险或容易重复踩的坑。
- `TASK_STATE`：当前任务进度。
- `TODO`：明确且尚未完成的下一步。

### 搜索和查看

```bash
polarbear-memory search "settlement retry"
polarbear-memory get MEMORY_ID
```

### 为任务生成 Context Pack

```bash
polarbear-memory context \
  --task "continue settlement recovery" \
  --budget 1000
```

### 验证或质疑 Memory

```bash
polarbear-memory verify MEMORY_ID \
  --result VERIFIED \
  --reason "Confirmed by the current implementation and recovery test"

polarbear-memory verify MEMORY_ID \
  --result DISPUTED \
  --reason "The implementation changed in SettlementPolicy"
```

### 查看状态和 token 节省估算

```bash
polarbear-memory status
polarbear-memory savings
```

`savings` 衡量的是“检索候选全部进入上下文”的估算基线，与实际 Context Pack token 的差值；它不是模型厂商账单，也不包含不可观测的推理 token。

开始新的统计周期：

```bash
polarbear-memory savings reset --confirm RESET
```

重置统计不会删除或修改 Memory。

### 生命周期维护

```bash
# 只预览计划
polarbear-memory maintain --dry-run

# 执行有界维护
polarbear-memory maintain
```

维护会处理 potentially stale、被替代知识、已完成短期任务和短期原始事件。长期 `DECISION` 和 `PITFALL` 不会仅因为时间久或使用少而被静默删除。

### 诊断和备份

```bash
polarbear-memory doctor
polarbear-memory backup create
polarbear-memory backup list
polarbear-memory backup verify /path/to/backup.db
```

查看全部命令：

```bash
polarbear-memory --help
```

## 自动 handoff 是怎么工作的

执行 `polarbear-memory claude install` 后，Claude Code 的 `Stop` 和 `SessionEnd` hook 会在本地处理简短、明确标记的内容：

```text
Decision: FAILED remains a terminal settlement state.
Pitfall: Retrying inside the transaction may duplicate settlement.
Task state: Recovery implementation is complete; regression test is pending.
Next step: Add the recovery regression test.
```

中文标签也受支持。已完成或取消的短期事项应明确标记：

```text
任务状态：[completed] Recovery endpoint 已完成。
下一步：[cancelled] 不再实现旧版 fallback。
```

系统不会猜测任务是否完成，也不会把普通对话填充或完整 transcript 当作长期 Memory。

## 数据与安全边界

- Memory 默认只保存在本机当前用户目录。
- `memory.db` 由 Memory Engine 管理，Desktop 和 WebView 不直接读写数据库。
- Engine 不使用 HTTP、HTTPS、DNS、TLS 或远程渲染服务。
- 不执行 Memory 中的 HTML、代码块、PlantUML 或其他远程资源。
- `forget` 是可恢复归档，不是物理删除。
- 诊断导出不会包含 Memory 正文、仓库路径、数据库路径或凭证。

## 常见问题

### `polarbear-memory: command not found`

确认全局 npm 可执行目录已经在 `PATH` 中，然后重新启动终端和 MCP 客户端：

```bash
npm prefix --global
npm install --global polarbear-memory
```

### `Project is not initialized`

在对应 Git 仓库中运行：

```bash
polarbear-memory init
```

### Claude Code 看不到 MCP 工具

依次确认：

```bash
polarbear-memory --version
polarbear-memory doctor
polarbear-memory claude install --dry-run
```

然后重新运行 `polarbear-memory claude install`、重启 Claude Code，并批准项目 MCP server。

## 从源码开发

```bash
git clone https://github.com/smartscity/polarbear-memory.git
cd polarbear-memory
npm ci --ignore-scripts
npm run build
npm link
```

质量检查：

```bash
npm run check
npm run package:check
```

## 文档

- [用户手册](docs/USER_MANUAL.md)
- [产品需求文档（PRD）](docs/PRD.md)
- [技术设计文档（TRD）](docs/TRD.md)
- [Memory 淘汰与保留验证方案](docs/MEMORY_RETENTION_VALIDATION.md)
- [npm 发布指南](docs/NPM_RELEASE.md)
- [安全策略](SECURITY.md)

## License

Polarbear Memory 使用 [Apache License 2.0](LICENSE)。
