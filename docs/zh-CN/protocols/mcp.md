# MCP 协议

[English](../../en/protocols/mcp.md)

## 角色

MCP 是 Agent-facing 兼容接口。它通过 stdio 暴露 Memory 与 Context OS 能力，不允许客户端直接访问数据库。

完整 tool schema、描述和结果行为只由以下源码维护：

- `src/protocol-mcp/server.ts`；
- `src/protocol-mcp/context-os-tools.ts`。

本文不复制完整 JSON schema。

## 接入 Agent

在目标仓库运行统一安装器：

```bash
cd /path/to/repository
polarbear-memory install
```

它会在需要时初始化项目，并一次配置当前支持的全部 Agent 集成：

- Claude Code：`.mcp.json`、Agent rules 和 lifecycle hooks；
- Codex：项目级 `.codex/config.toml` 和 MCP server instructions。

Claude Code 对 MCP tool call 的授权独立于 server 安装。安装器会为 13 个默认 Polarbear MCP tools 添加精确的项目级 allow rules，其中包括 `decision_record`，因此日常 Context OS 操作不会在每个 session 或 worktree 中反复询问。安装器保留无关 permission rules，并且不使用通配符；可选 Admin tools 和未来新增 tools 必须经过显式评审后才能自动授权。

安装后重启正在运行的 Agent 客户端。安装器会保留无关配置并备份托管修改。Codex 安装器把同名条目分为当前托管、旧版托管、可修复 Polarbear 配置或外部冲突：当前配置会被安全刷新；早期版本生成的 PATH 依赖配置，以及可以明确判断为启动当前已安装 Polarbear 包的配置，会被自动迁移；只有无法确认 Polarbear 所有权的条目才会作为未托管冲突拒绝覆盖。重复运行安装器是幂等的。移动或升级当前 runtime 后，应重新运行安装器。使用 `polarbear-memory install --dry-run` 可以进行无修改预览。

其他兼容 MCP 的客户端可手动配置同一个 stdio server：

```json
{
  "command": "/当前-node-runtime/的绝对路径",
  "args": [
    "/polarbear-memory/dist/cli.js/的绝对路径",
    "mcp",
    "--stdio",
    "--project-root",
    "/仓库的绝对路径"
  ]
}
```

Runtime 与 CLI 路径必须属于同一个可工作的 Polarbear 安装。受支持的安装器从当前 Polarbear 进程取得这两个路径，不搜索 shell profile、runtime manager 或 `PATH`。该进程由客户端启动。正常使用时，用户不需要在终端手动运行 `polarbear-memory mcp --stdio`，也不需要手动调用 MCP 工具。

`polarbear-memory doctor` 会在最小环境中检查配置是否过期、runtime 与 CLI 是否存在，并执行 MCP initialize handshake。探针在收到 initialize 响应前保持 stdin 打开，随后终止一次性子进程并等待其 stdio handle 关闭。这样可避免响应与 EOF 触发的 server shutdown 竞速，并防止遗留孤儿探针。失败信息会区分 spawn、提前退出、initialize 超时、协议、I/O 和清理阶段。即使配置条目存在，runtime 路径失效也会报告失败。

## 默认工具分组

| 分组 | 工具 |
|---|---|
| 兼容 Memory | `memory_context`、`memory_get`、`memory_search`、`memory_record`、`memory_verify` |
| Context OS | `context_get`、`context_explain`、`task_create`、`task_get`、`task_checkpoint`、`decision_record`、`constraint_record`、`memory_feedback` |

显式启用 `--admin-tools` 时，额外提供 `memory_status` 和可逆的 `memory_forget`。

## Transport 与安全

- 当前 transport 是 MCP stdio。
- stdout 只输出协议帧，诊断信息写 stderr。
- 所有输入先校验和限长。
- 文件路径必须保持 repo-relative，不能通过 symlink 逃逸。
- Memory 返回值明确是“不可信项目数据”。
- Server 不进行隐式联网。
- 已有 Memory 工具名和行为保持兼容。

## Context 工作流

Claude lifecycle hooks 无需模型选择 MCP tool，就能完成日常检索、观察、turn distillation 与 compaction checkpoint。MCP 继续承担显式 data/tool plane：

1. 使用 `memory_search` 深入调查历史信息；
2. 使用 Memory ID 通过 `memory_get` 渐进展开；
3. 自动注入的 Packet 需要显式检查或扩展时，使用 `context_get` 或 `context_explain`；
4. 只有在有意进行人工修正、兼容模式或 provider 缺少 lifecycle 控制时，才使用 Task 与记录工具。

Stock Codex 使用 MCP-assisted 兼容模式。独立安装的 Polarbear App Server gateway 只有在 embedding client 的完整 JSONL stream 都经过它时才是 lifecycle-managed；它不能改变普通 Codex CLI/Desktop session 的 capability claim。
