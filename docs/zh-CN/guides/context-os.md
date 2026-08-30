# Context OS 工作流

[English](../../en/guides/context-os.md)

## 正常使用

在项目中一次性安装集成：

```bash
polarbear-memory install
```

之后正常使用 Codex 或 Claude Code。Agent 集成负责执行 Context OS 工作流：

1. session 开始或工作切换时调用 `context_get`；
2. 实质性多 session 工作没有 durable Task 时使用 `task_create`；
3. 在决策和约束确定后保存可复用知识；
4. handoff、rotation 或替换 session 前调用 `task_checkpoint`；
5. 新 session 从最新 checkpoint 和有限 Context Packet 继续。

这些 MCP 调用是 Agent-facing 操作，正常工作时不需要用户手动执行。

## Session 边界

Claude Code 使用安装好的 lifecycle hooks。`SessionStart` 可提供任务上下文，`PreCompact` 保存边界，`SessionEnd` 执行有界确定性提炼。

Codex 使用项目级 MCP 配置和 Polarbear MCP server 发布的 instructions。结束实质性工作前，Agent 必须在 checkpoint 中保存 changed file、finding、verification、unresolved question 和 remaining work。

Polarbear 无法恢复从未 checkpoint 的 provider history。Agent 保存安全边界后，再结束或轮换 session。

## 手动检查

以下命令用于检查和诊断，不是正常用户工作流：

```bash
polarbear-memory task status
polarbear-memory context explain PACKET_ID
polarbear-memory metrics --task TASK_ID
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
