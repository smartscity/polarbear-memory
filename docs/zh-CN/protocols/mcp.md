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

安装后重启正在运行的 Agent 客户端。安装器保留无关配置，并备份托管修改。使用 `polarbear-memory install --dry-run` 可以进行无修改预览。

其他兼容 MCP 的客户端可手动配置同一个 stdio server：

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

以下工作流由 Agent 集成执行，不是用户日常需要手动完成的操作：

1. 获取 durable Task，或通过 `task_create` 创建。
2. 使用 Task ID 和当前请求调用 `context_get`。
3. 通过 `memory_get` 渐进展开 Memory。
4. 显式记录 durable decision 与 constraint。
5. Handoff 或 rotation 前使用 `task_checkpoint`。
6. 使用 `context_explain` 检查选择与排除原因。
