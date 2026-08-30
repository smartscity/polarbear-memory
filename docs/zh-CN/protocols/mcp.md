# MCP 协议

[English](../../en/protocols/mcp.md)

## 角色

MCP 是 Agent-facing 兼容接口。它通过 stdio 暴露 Memory 与 Context OS 能力，不允许客户端直接访问数据库。

完整 tool schema、描述和结果行为只由以下源码维护：

- `src/protocol-mcp/server.ts`；
- `src/protocol-mcp/context-os-tools.ts`。

本文不复制完整 JSON schema。

## 接入 Agent

连接客户端前，先在目标仓库初始化 Polarbear Memory：

```bash
cd /path/to/repository
polarbear-memory init
```

Claude Code 需要一次性安装托管的 MCP 配置、Agent rules 和 lifecycle hooks：

```bash
polarbear-memory claude install --dry-run
polarbear-memory claude install
```

安装后重启 Claude Code。集成会合并受支持的现有配置，并在修改托管文件前创建备份。

Codex 或其他兼容 MCP 的客户端，需要在项目配置中添加以下 stdio server：

```json
{
  "command": "polarbear-memory",
  "args": ["mcp", "--stdio", "--project-root", "/absolute/path/to/repository"]
}
```

该进程由客户端启动。正常使用时，用户不需要在终端手动运行 `polarbear-memory mcp --stdio`，也不需要手动调用 MCP 工具。

## 默认工具分组

| 分组 | 工具 |
|---|---|
| 兼容 Memory | `memory_context`、`memory_get`、`memory_search`、`memory_record`、`memory_verify` |
| Context OS | `context_get`、`context_explain`、`task_get`、`task_checkpoint`、`decision_record`、`constraint_record`、`memory_feedback` |

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

以下工作流由 Agent 集成执行，不是用户日常需要手动完成的操作：

1. 通过 Agent 集成或 Admin API 获取、创建 durable Task。
2. 使用 Task ID 和当前请求调用 `context_get`。
3. 通过 `memory_get` 渐进展开 Memory。
4. 显式记录 durable decision 与 constraint。
5. Handoff 或 rotation 前使用 `task_checkpoint`。
6. 使用 `context_explain` 检查选择与排除原因。
