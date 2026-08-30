# 快速开始

[English](../../en/guides/getting-started.md)

## 环境要求

- Node.js `>=24.10.0 <27`；
- npm；
- Git 仓库；
- Codex 或 Claude Code。

## 1. 安装 CLI

```bash
npm install --global polarbear-memory
```

## 2. 在项目中安装 Polarbear Memory

进入目标仓库，运行统一安装器：

```bash
cd /path/to/repository
polarbear-memory install
```

这一个命令会：

- 在需要时初始化仓库和本地 SQLite 存储；
- 配置 Claude Code MCP、Agent rules 和 lifecycle hooks；
- 配置项目级 Codex MCP 和 server instructions；
- 使用执行安装器的确切 Node runtime 与包内 CLI，为 Polarbear Desktop 发布本地 runtime descriptor；
- 保留无关配置，并在修改托管文件前创建备份。

安装后重启正在运行的 Agent 客户端。可以先运行 `polarbear-memory install --dry-run` 进行无修改预览。

## 3. 正常工作

像平时一样使用 Agent。MCP 工具和 lifecycle hooks 会取得有限上下文、保存可复用知识，并为实质性工作创建 checkpoint。这些是 Agent-facing 操作，正常使用时不需要用户手动调用。

保存安全 checkpoint 后，可以在对话变大时关闭当前 session。新 session 从持久任务状态和筛选后的 Memory 继续，不需要携带完整旧对话。

## 验证

```bash
polarbear-memory doctor
```

安装完成后，`Claude MCP` 和 `Codex MCP` 的 config、executable 与 handshake 都应显示 `OK`。Polarbear Desktop 会读取同一份托管 runtime descriptor，不依赖交互式 shell 的 PATH。如果 runtime 升级导致绝对路径过期，重新运行 `polarbear-memory install` 可修复 Desktop 和所有受支持的 Agent；只修复 Codex 时可运行 `polarbear-memory codex install`。

## 下一步

- [MCP 接入与 Agent 工作流](../protocols/mcp.md)
- [Context OS 工作流](./context-os.md)
- [Memory Engine 设计](../architecture/memory-engine.md)
- [运维与恢复](./operations.md)
