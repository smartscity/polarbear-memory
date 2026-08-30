# 快速开始

[English](../../en/guides/getting-started.md)

## 环境要求

- `package.json` 声明范围内的 Node.js；
- npm；
- Git 仓库；
- 只有需要对应 provider 集成时才需要 Codex 或 Claude Code。

## 安装

```bash
npm install --global polarbear-memory
polarbear-memory --version
```

## 初始化仓库

```bash
cd /path/to/repository
polarbear-memory init --dry-run
polarbear-memory init
```

初始化创建 `.polarbear/config.toml`。SQLite 数据库位于当前用户的 Polarbear 数据目录，不提交到仓库。

## 记录与检索 Memory

```bash
polarbear-memory record \
  --type DECISION \
  --summary "Use the local Admin API" \
  --content "Desktop must never open memory.db directly"

polarbear-memory search "Desktop database boundary"
polarbear-memory context --task "continue Desktop integration" --budget 1000
```

完整命令面以 `polarbear-memory --help` 为准，本文只维护常用工作流。

## 启用 MCP

一次性接入 Claude Code、Codex 或其他兼容 MCP 的 Agent，之后即可正常使用 Agent。安装命令、客户端配置、工具分组和安全规则统一由 [MCP 接入与协议文档](../protocols/mcp.md) 维护。

## 验证与维护

```bash
polarbear-memory verify MEMORY_ID --result VERIFIED --reason "Confirmed by current code and tests"
polarbear-memory maintain --dry-run
polarbear-memory maintain
polarbear-memory doctor
polarbear-memory backup create
```

长期知识不会仅因为时间久被静默 purge。下一步可阅读 [Context OS 工作流](./context-os.md) 和 [运维与恢复](./operations.md)。
