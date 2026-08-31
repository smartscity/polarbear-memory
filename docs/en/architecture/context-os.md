# Agent Context OS

[简体中文](../../zh-CN/architecture/context-os.md)

## Decision

Durable task state belongs to Polarbear. Codex and Claude Code sessions are bounded, replaceable execution environments.

The Context OS extends the Memory Engine; it does not replace the Option B storage model.

```mermaid
flowchart LR
  Observe --> Distill --> Memory[Memory Engine]
  Memory --> Retrieve --> Assemble[Context Planner]
  Assemble --> Packet[Immutable Context Packet]
  Packet --> Execute[Agent Runtime]
  Execute --> Checkpoint
  Checkpoint --> Memory
```

## Domain model

- **Task:** durable objective, status, phase, priority, and latest checkpoint.
- **Checkpoint:** structured snapshot and delta of changed work, findings, decisions, constraints, failures, verification, unresolved items, and remaining work.
- **Context Packet:** immutable, versioned, token-bounded projection with source provenance.
- **Agent Session:** opaque provider-session mapping; external identifiers are stored as hashes.
- **Execution Run:** one managed or assisted execution attempt associated with task, packet, session, provider, and outcome.
- **Observation:** validated and redacted provider-neutral activity event.
- **Usage Ledger / Retrieval Run:** logical context and provider-usage evidence.

The domain contract is owned by `src/domain/context-os.ts`.

## Context planning

The planner combines task state, latest checkpoint, hybrid Memory search, and recent scoped Memory. It reserves mandatory P0 slots for the first available:

- objective;
- working state;
- hard constraint;
- accepted decision;
- high-risk or disputed verification item.

Optional architecture, episodic, verification, and semantic candidates are admitted only within their category and total budgets. Large items are truncated but retain source IDs for progressive disclosure. The final rendered packet is never allowed to exceed its configured hard budget.

Every packet records its hash, sources, selection reasons, category usage, exclusions, estimated tokens, and retrieval latency. Raw current requests are returned to the caller but only a digest is persisted.

## Observe and distill

Claude assisted mode supports SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, PostCompact, Stop, and SessionEnd hooks.

- hook payloads are bounded and redacted;
- raw prompts are represented by digests;
- SessionStart can return task context selected by `POLARBEAR_TASK_ID`;
- PreCompact persists a checkpoint boundary;
- SessionEnd runs bounded deterministic distillation;
- duplicate event fingerprints are idempotent;
- database failures spool events locally for later replay.

The baseline distiller extracts only explicitly labeled reusable decisions, pitfalls, task state, and next steps. It does not claim general semantic understanding of arbitrary tool output.

## Managed runtimes and rotation

`AgentRuntime` is provider-neutral. Codex and Claude Code adapters implement detection, start, resume, JSONL event parsing, usage extraction, and provider permission arguments.

Managed sessions are disabled unless `POLARBEAR_MANAGED_SESSIONS=1`.

- Codex defaults to its `read-only` sandbox; writable mode selects `workspace-write`.
- Claude Code defaults to `--permission-mode plan`; writable mode selects `acceptEdits`.
- A model override is passed to the provider and stored with the run.

Rotation is deterministic. Signals include task or phase changes, context budget, pollution, compaction, run/turn limits, provider failure, and manual requests. A rotation without an existing durable checkpoint is rejected. When allowed, Polarbear persists a new rotation-boundary checkpoint before launching a fresh session.

Resume failure records the failed run and falls back to a fresh session using the same durable task and packet.

## Persistence

Schema v8 adds tasks, agent sessions, execution runs, observations, checkpoints, retrieval runs, context packets/items, and usage ledger records. The migration is additive, backed up, transactional, and foreign-key checked.

## Desktop UX contract

Polarbear Desktop is a focused Context client, not a Memory database administration surface. Its primary workflows are viewing assembled Context, searching durable Memory, and resolving rare exceptions. The full project path is visible in the Context header.

- Context usage is shown as assembled tokens over the active budget. Budget mode is either `auto` or `custom`; `auto` is the default.
- Savings are shown as a positive `Token savings` percentage. When assembled Context is larger than the comparison baseline, Desktop shows `Token impact` and a positive `more` percentage instead of a negative reduction.
- Normal active Memory does not require approval. Attention is reserved for conflicts, disputed Memory, and important low-confidence or stale Memory.
- Confirming an exception persists verification. Rejecting it removes the Memory from retrieval while retaining its revision history.
- Engine and MCP lifecycle is automatic. Desktop reports Codex and Claude Code integration health through the Admin API and offers a bounded repair action; it does not expose start/stop process controls.
- Desktop never reads project configuration, Agent configuration, or `memory.db` directly. Budget settings, integration health, and repair all cross the versioned Admin API.

## Verification evidence

Automated coverage includes:

- task/checkpoint persistence and idempotency;
- mandatory P0 budget behavior and packet traceability;
- Context OS A/B/C evaluation fixtures;
- Claude SessionStart and PreCompact lifecycle behavior;
- Codex and Claude CLI JSONL/permission contracts;
- checkpoint-before-rotation and resume recovery;
- Codex-to-Claude and Claude-to-Codex handoff.

Real provider billing measurements, sustained dogfood, and release-time CLI compatibility remain external release evidence rather than code-level claims.
