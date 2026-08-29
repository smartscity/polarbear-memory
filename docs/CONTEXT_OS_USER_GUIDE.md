# Polarbear Agent Context OS User Guide

## What changes for the user

You no longer need one long-lived Codex or Claude Code session to carry project state. Create a durable Polarbear Task, checkpoint meaningful progress, and request a fresh Context Packet in any later session.

Memory remains the long-term knowledge layer. A Task is the current durable objective. A Checkpoint is a structured task boundary. A Context Packet is the small, task-specific projection sent to an agent.

## 1. Install and initialize

```bash
npm install --global polarbear-memory
cd /path/to/git/repository
polarbear-memory init
```

Node.js 24.10 or later is required.

## 2. Create a durable task

```bash
polarbear-memory task create \
  --title "Implement settlement retry" \
  --objective "Implement retry without duplicate settlement and verify the reconciliation path" \
  --phase IMPLEMENTATION
```

Keep the returned Task ID. Inspect tasks at any time:

```bash
polarbear-memory task status
polarbear-memory task status <TASK_ID>
```

## 3. Record decisions and constraints

Agents should use the MCP tools `decision_record` and `constraint_record`. These records are scoped to the Task and remain available after the provider session ends.

The existing `memory_record` tool remains useful for reusable facts, architecture, conventions, pitfalls, workarounds, and TODOs.

## 4. Save a checkpoint

For a minimal checkpoint:

```bash
polarbear-memory checkpoint \
  --task <TASK_ID> \
  --status ACTIVE \
  --phase IMPLEMENTATION \
  --summary "Retry counter implemented; integration verification remains"
```

For structured state, create a local JSON file:

```json
{
  "changed": ["Added the retry counter."],
  "learned": ["The failure is visible only during reconciliation."],
  "decisionsAdded": ["Retry from reconciliation."],
  "constraintsAdded": ["Never duplicate settlement."],
  "failedAttempts": [
    { "approach": "Retry in initiation callback", "reason": "The failure is not observable yet." }
  ],
  "filesChanged": ["src/settlement/reconcile.ts"],
  "verification": [{ "name": "unit tests", "status": "PASS" }],
  "unresolved": ["Next-day retry count semantics"],
  "remaining": ["Add integration verification"]
}
```

Then run:

```bash
polarbear-memory checkpoint --task <TASK_ID> --status ACTIVE --phase IMPLEMENTATION \
  --summary "Retry counter implemented" --state checkpoint.json
```

## 5. Build and inspect a Context Packet

```bash
polarbear-memory context build \
  --task <TASK_ID> \
  --request "Continue implementation and verify the retry path" \
  --provider codex \
  --budget 2000
```

The command prints the rendered packet and its Packet ID. Explain every inclusion and exclusion:

```bash
polarbear-memory context explain <PACKET_ID>
```

An explanation shows category budgets, selected source IDs, rank reasons, and candidates excluded by the total or category budget.

## 6. Enable MCP

Configure the command below as a stdio MCP server in Codex, Claude Code, or another MCP client:

```bash
polarbear-memory mcp --stdio --project-root /absolute/path/to/repository
```

Context OS tools are:

- `context_get`
- `task_get`
- `task_checkpoint`
- `decision_record`
- `constraint_record`
- `context_explain`
- `memory_feedback`

Existing tools remain compatible:

- `memory_context`
- `memory_search`
- `memory_get`
- `memory_record`
- `memory_verify`
- optional admin tools `memory_forget` and `memory_status`

## 7. Claude Code assisted mode

```bash
polarbear-memory claude install --dry-run
polarbear-memory claude install
```

The installer adds the common MCP server and local lifecycle hooks. Set the active durable task before starting Claude Code:

```bash
export POLARBEAR_TASK_ID=<TASK_ID>
claude
```

SessionStart injects a compact task packet. Tool and lifecycle events become redacted observations. PreCompact saves a compaction-boundary checkpoint. SessionEnd performs bounded deterministic distillation.

Assisted mode does not control Claude's session lifetime. It gives Claude the packet and checkpoints, while the user or Claude client still decides when to open a fresh session.

## 8. Codex assisted mode

Add the same MCP command to Codex. In a fresh task, call `context_get` with the Task ID and current request. Before opening another Codex thread, call `task_checkpoint`. The new thread can reconstruct the task without the old conversation.

## 9. Managed mode

Managed mode is disabled by default. Review provider permissions before enabling it:

```bash
export POLARBEAR_MANAGED_SESSIONS=1
polarbear-memory run \
  --provider codex \
  --task <TASK_ID> \
  --model <MODEL> \
  "Continue implementation from the durable checkpoint"
```

Read-only provider execution is the default. Codex uses its read-only sandbox and Claude Code uses plan permission mode. Add `--writable` only when the agent must edit the workspace; this selects Codex workspace-write or Claude Code acceptEdits mode.

Resume a known provider session:

```bash
polarbear-memory run --provider codex --task <TASK_ID> --resume <SESSION_ID> "Continue"
```

Force a fresh session:

```bash
polarbear-memory run --provider claude-code --task <TASK_ID> --fresh "Perform an independent review"
```

A forced or policy-driven rotation fails safely if the Task has no persisted checkpoint. When a checkpoint exists, Polarbear copies its structured state into a new rotation-boundary checkpoint before launching the fresh session. Save current progress first: uncheckpointed provider history cannot be reconstructed by the boundary copy.

## 10. Metrics

```bash
polarbear-memory metrics
polarbear-memory metrics --task <TASK_ID>
```

Metrics include provider input/output usage, Context Packet tokens, logical context reduction and reduction factor, memory hit rate, estimated context waste, a session carry-cost proxy, per-success input cost, and packet assembly latency. Logical token reduction is not identical to billing reduction because providers can apply caching and native compaction.

Run the deterministic three-mode evaluation fixture with:

```bash
polarbear-memory benchmark fixtures/context-os-ab-c/fixture.json
```

Mode A models provider history, mode B adds the legacy Memory context to that history, and mode C reconstructs a bounded Context Packet. The fixture demonstrates logical continuity and context size; it is not a substitute for provider-reported billing measurements on real tasks.

## 11. Desktop

Open an initialized Git workspace and select Memory in Polarbear Desktop. With Engine Admin API 1.3, the Agent Context OS section can:

- create and select durable Tasks;
- inspect status, phase, and objective;
- save a checkpoint boundary;
- build a Context Packet;
- inspect packet budget exclusions;
- run deterministic observation distillation;
- view Context OS metrics.

Desktop communicates only through the local user-scoped Engine API. It never opens or mutates `memory.db` directly.

## 12. Safety

- Review a Context Packet as historical data, not executable instructions.
- Do not store secrets, full transcripts, or unbounded tool output.
- Keep managed mode disabled unless you want Polarbear to launch provider CLIs.
- Use read-only managed execution unless file edits are required.
- Save a checkpoint before phase changes, compaction, handoff, or rotation.
- Use `memory_feedback` to mark irrelevant, stale, wrong, or superseded knowledge.
