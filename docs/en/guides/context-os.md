# Context OS workflow

[简体中文](../../zh-CN/guides/context-os.md)

## Normal use

Install the project integrations once:

```bash
polarbear-memory install
```

Then use Codex or Claude Code normally. The Agent integration performs the Context OS workflow:

1. call `context_get` at session start or when work changes;
2. use `task_create` when substantive multi-session work has no durable Task;
3. record reusable decisions and constraints as they become established;
4. call `task_checkpoint` before handoff, rotation, or session replacement;
5. continue a fresh session from the latest checkpoint and a bounded Context Packet.

These MCP calls are Agent-facing operations. Users do not invoke them manually during normal work.

## Session boundaries

Claude Code uses installed lifecycle hooks. `SessionStart` can provide task context, `PreCompact` persists a boundary, and `SessionEnd` performs bounded deterministic distillation.

Codex uses project-scoped MCP configuration and the instructions published by the Polarbear MCP server. Before ending substantive work, the Agent must persist changed files, findings, verification, unresolved questions, and remaining work in a checkpoint.

Polarbear cannot reconstruct provider history that was never checkpointed. End or rotate a session after the Agent has stored a safe boundary.

## Inspect manually

Manual commands are available for inspection and diagnostics, not as the normal user workflow:

```bash
polarbear-memory task status
polarbear-memory context explain PACKET_ID
polarbear-memory metrics --task TASK_ID
polarbear-memory doctor
```

## Managed execution

Managed provider processes are an optional advanced mode:

```bash
export POLARBEAR_MANAGED_SESSIONS=1
polarbear-memory run --provider codex --task TASK_ID "Continue from the durable checkpoint"
```

Managed execution is read-only by default. Add `--writable` only when workspace edits are required. A fresh or policy-driven rotation requires an existing checkpoint.

Logical context reduction is not identical to provider billing reduction. Real usage claims require provider-reported measurements.
