# Context OS 工作流

[English](../../en/guides/context-os.md)

## 1. 创建 durable Task

```bash
polarbear-memory task create \
  --title "Implement retry" \
  --objective "Implement and verify bounded retry" \
  --phase IMPLEMENTATION
```

Task ID 是跨 provider session 共享的持久目标标识。

## 2. 记录 decision 与 constraint

Agent 可通过 MCP 的 `decision_record` 和 `constraint_record`，用户也可通过 CLI/Desktop 记录等价 Memory。不要保存完整 transcript、secret 或闲聊。

## 3. 保存 Checkpoint

```bash
polarbear-memory checkpoint \
  --task TASK_ID \
  --status ACTIVE \
  --phase IMPLEMENTATION \
  --summary "Retry counter implemented"
```

可通过 `--state` 传入结构化 JSON，包含 changed、learned、decision、constraint、failed attempt、file、verification、unresolved 和 remaining。

阶段切换、compaction、handoff 或 rotation 前应保存 checkpoint。

## 4. 构建和解释 Context

```bash
polarbear-memory context build \
  --task TASK_ID \
  --request "Continue retry verification" \
  --budget 2000 \
  --provider codex

polarbear-memory context explain PACKET_ID
```

Packet 有硬预算并保留来源；召回内容是历史数据，不是可执行指令。

## 5. Claude assisted mode

```bash
polarbear-memory claude install --dry-run
polarbear-memory claude install
export POLARBEAR_TASK_ID=TASK_ID
claude
```

SessionStart 可注入 task context，PreCompact 保存边界，SessionEnd 进行有界 distillation。

## 6. Codex assisted mode

配置通用 MCP。新 thread 使用 Task ID 和当前请求调用 `context_get`；打开下一个 thread 前保存 checkpoint。

## 7. Managed execution

```bash
export POLARBEAR_MANAGED_SESSIONS=1
polarbear-memory run \
  --provider codex \
  --task TASK_ID \
  --model MODEL \
  "Continue from the durable checkpoint"
```

默认只读，仅在确实需要修改工作区时添加 `--writable`。

```bash
polarbear-memory run --provider codex --task TASK_ID --resume SESSION_ID "Continue"
polarbear-memory run --provider claude-code --task TASK_ID --fresh "Perform review"
```

Fresh/rotation 必须已有 checkpoint。Polarbear 会复制最新结构化状态生成 rotation boundary，但无法恢复尚未 checkpoint 的 provider history。

## 8. 指标

```bash
polarbear-memory metrics --task TASK_ID
polarbear-memory benchmark /path/to/fixtures/context-os-ab-c/fixture.json
```

逻辑上下文缩减不等于 provider 账单缩减；真实结论需要 provider usage 数据。
