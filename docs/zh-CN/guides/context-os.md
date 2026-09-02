# Context OS 工作流

[English](../../en/guides/context-os.md)

## 正常使用

在项目中一次性安装集成：

```bash
polarbear-memory install
```

之后正常使用 Codex 或 Claude Code。

- Claude Code lifecycle hooks 会自动解析 durable Task、检索 prompt-specific Context、观察 tool 结果、在每个 turn 结束时提炼带标签的持久状态，并在 compaction 时创建 checkpoint。
- Stock Codex 使用 MCP-assisted 兼容模式。Embedding client 可以显式安装并启动 Polarbear App Server gateway，在模型处理前拦截 turn。

用户正常工作时不需要手动执行 Memory 命令。自动注入的 Context 需要更深历史信息时，仍可显式使用 MCP 搜索和检查。

## Session 边界

Claude Code 使用安装好的 lifecycle hooks。`SessionStart` 和 `UserPromptSubmit` 注入有界 Context，`Stop` 与 `StopFailure` 执行 session-scoped 确定性提炼，`PreCompact` 保存 continuation state，`SessionEnd` 只执行有界的最终 flush。

Codex 默认使用项目级 MCP 配置。在可选的 managed gateway 中，Polarbear 会注入 prompt-specific Context，并观察官方 thread、turn、item、approval 与 compaction stream，但不会修改 approval decision。

在 Codex MCP-assisted 模式中，Polarbear 无法恢复 Agent 从未 checkpoint 的 provider history。Agent 保存安全边界后，再结束或轮换 Codex session。

## 手动检查

以下命令用于检查和诊断，不是正常用户工作流：

```bash
polarbear-memory task status
polarbear-memory context explain PACKET_ID
polarbear-memory metrics --task TASK_ID
polarbear-memory metrics --lifecycle
polarbear-memory doctor
```

## Managed execution

托管 provider 进程是可选高级模式：

```bash
export POLARBEAR_MANAGED_SESSIONS=1
polarbear-memory run --provider codex --task TASK_ID "Continue from the durable checkpoint"
```

Managed execution 默认只读，只在确实需要修改工作区时添加 `--writable`。Fresh 或策略驱动的 rotation 必须已有 checkpoint。

逻辑上下文缩减不等同于 provider 账单缩减，真实用量结论需要 provider 上报数据。

## Managed Codex App Server

Embedding client 可以使用绝对 Codex executable 安装 self-contained launch descriptor：

```bash
polarbear-memory codex app-server install --codex-command /absolute/path/to/codex
polarbear-memory codex app-server run --codex-command /absolute/path/to/codex --task TASK_ID
```

Gateway 使用本地 stdio JSONL，不会增加 network access，并原样转发 server-initiated approval request 与 client decision。安装 descriptor 不会改变 stock Codex CLI/Desktop 行为。
