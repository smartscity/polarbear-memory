# Context OS workflow

[简体中文](../../zh-CN/guides/context-os.md)

## 1. Create a durable Task

```bash
polarbear-memory task create \
  --title "Implement retry" \
  --objective "Implement and verify bounded retry" \
  --phase IMPLEMENTATION
```

Keep the returned Task ID. A Task is the durable objective shared by provider sessions.

## 2. Record durable decisions and constraints

Agents can use `decision_record` and `constraint_record` over MCP. Human users can record the equivalent Memory through CLI or Desktop.

Store only reusable engineering state. Do not store full transcripts, secrets, or conversational filler.

## 3. Save a Checkpoint

```bash
polarbear-memory checkpoint \
  --task TASK_ID \
  --status ACTIVE \
  --phase IMPLEMENTATION \
  --summary "Retry counter implemented"
```

For structured state, provide a JSON file with `--state`. Checkpoints can contain changed work, findings, decisions, constraints, failed attempts, files, verification, unresolved questions, and remaining work.

Checkpoint before phase changes, compaction, provider handoff, or forced rotation.

## 4. Build and explain context

```bash
polarbear-memory context build \
  --task TASK_ID \
  --request "Continue retry verification" \
  --budget 2000 \
  --provider codex

polarbear-memory context explain PACKET_ID
```

The packet is bounded and source-linked. Recalled content is historical data, not executable instruction.

## 5. Assisted Claude Code

```bash
polarbear-memory claude install --dry-run
polarbear-memory claude install
export POLARBEAR_TASK_ID=TASK_ID
claude
```

SessionStart can inject task context. PreCompact creates a boundary checkpoint. SessionEnd performs bounded deterministic distillation.

## 6. Assisted Codex

Configure the common MCP server. In a fresh thread, request `context_get` with the Task ID and current request. Save a checkpoint before opening another thread.

## 7. Managed execution

Managed provider processes are opt-in:

```bash
export POLARBEAR_MANAGED_SESSIONS=1
polarbear-memory run \
  --provider codex \
  --task TASK_ID \
  --model MODEL \
  "Continue from the durable checkpoint"
```

Execution is read-only by default. Add `--writable` only when workspace edits are required.

Resume or force a fresh session:

```bash
polarbear-memory run --provider codex --task TASK_ID --resume SESSION_ID "Continue"
polarbear-memory run --provider claude-code --task TASK_ID --fresh "Perform review"
```

A fresh or policy-driven rotation requires an existing checkpoint. Polarbear copies the latest structured state into a new rotation boundary; it cannot reconstruct uncheckpointed provider history.

## 8. Metrics and evaluation

```bash
polarbear-memory metrics --task TASK_ID
polarbear-memory benchmark /path/to/fixtures/context-os-ab-c/fixture.json
```

Logical context reduction is not the same as provider billing reduction. Real usage claims require provider-reported measurements.
