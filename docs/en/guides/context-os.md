# Context OS workflow

[简体中文](../../zh-CN/guides/context-os.md)

## Normal use

Install the project integrations once:

```bash
polarbear-memory install
```

Then use Codex or Claude Code normally.

- Claude Code lifecycle hooks automatically resolve durable task state, retrieve prompt-specific Context, observe tool outcomes, distill labeled durable state at the end of each turn, and checkpoint compaction.
- Stock Codex uses MCP-assisted compatibility mode. For an embedding client, install and launch the explicit Polarbear App Server gateway to intercept turns before model processing.

Users do not invoke Memory commands manually during normal work. Explicit MCP search and inspection remain available when the automatically injected Context needs deeper historical detail.

## Session boundaries

Claude Code uses installed lifecycle hooks. `SessionStart` and `UserPromptSubmit` inject bounded Context, `Stop` and `StopFailure` perform session-scoped deterministic distillation, `PreCompact` persists continuation state, and `SessionEnd` performs only a bounded final flush.

Codex uses project-scoped MCP configuration by default. In the optional managed gateway, Polarbear injects prompt-specific Context and observes the official thread, turn, item, approval, and compaction stream without changing approval decisions.

In Codex MCP-assisted mode, Polarbear cannot reconstruct provider history that the Agent never checkpointed. End or rotate a Codex session after the Agent has stored a safe boundary.

## Inspect manually

Manual commands are available for inspection and diagnostics, not as the normal user workflow:

```bash
polarbear-memory task status
polarbear-memory context explain PACKET_ID
polarbear-memory metrics --task TASK_ID
polarbear-memory metrics --lifecycle
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

## Managed Codex App Server

Embedding clients can install a self-contained launch descriptor with an absolute Codex executable:

```bash
polarbear-memory codex app-server install --codex-command /absolute/path/to/codex
polarbear-memory codex app-server run --codex-command /absolute/path/to/codex --task TASK_ID
```

The gateway uses local stdio JSONL, does not add network access, and forwards server-initiated approval requests and client decisions unchanged. Installing the descriptor does not change stock Codex CLI/Desktop behavior.
