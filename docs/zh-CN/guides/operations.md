# 运维、维护与恢复

[English](../../en/guides/operations.md)

## 诊断

```bash
polarbear-memory status
polarbear-memory doctor
polarbear-memory doctor --export
```

Diagnostics export 不包含 Memory 正文、仓库路径、token 和原始 session ID。当已配置的 Agent integration 过期、无法启动、发生冲突或 MCP handshake 失败时，doctor 返回非零退出状态；从未配置的可选 Agent 会显示状态，但不会导致命令失败。

## Lifecycle maintenance

```bash
polarbear-memory maintain --dry-run
polarbear-memory maintain
```

维护是有界操作：重新评估 source anchor、归档符合条件的已完成短期状态、清理 raw event buffer。长期 canonical knowledge 不会因时间或低使用率被自动 purge。

## Backup 与 restore

```bash
polarbear-memory backup create
polarbear-memory backup list
polarbear-memory backup verify /path/to/backup.db
polarbear-memory backup restore /path/to/backup.db --confirm /path/to/backup.db
```

Restore 有 preview/confirm 边界并保留 rollback database。执行独占维护或 restore 前关闭 MCP、CLI、hook 和 Desktop 操作。

## 重建搜索索引

```bash
polarbear-memory rebuild-index
```

重建 FTS 不修改 canonical Knowledge。

## Claude hook spool

数据库暂时不可用时，hook 会写入有界本地 spool：

```bash
polarbear-memory spool replay
```

## 移除集成

```bash
polarbear-memory uninstall --dry-run
polarbear-memory uninstall --keep-data
```

永久删除必须按 CLI 提示显式确认 Project ID，并应先创建已验证备份。

## 常见错误

- `Project is not initialized`：在 Git 仓库中运行 `polarbear-memory install`，同时初始化项目并接入受支持的 Agent。
- Agent MCP runtime 过期：运行 `polarbear-memory install` 修复全部托管集成，或使用对应 Agent 的安装命令只修复该客户端。
- Provider unavailable：安装官方 CLI 并确认在 `PATH`。
- Rotation requires checkpoint：fresh session 前保存当前结构化状态。
- Database busy：关闭仍存活的长连接，不要手工删除活动 lease。
- Admin API mismatch：同步升级 Engine/Desktop，不能绕过 API 直接读 SQLite。
