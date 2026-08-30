# Product and roadmap

[简体中文](../../zh-CN/planning/product-and-roadmap.md)

## Product

Polarbear is a local-first context operating system and durable engineering-memory layer for coding agents.

Its core product promise is:

> Durable project state belongs to Polarbear. Agent sessions are replaceable execution environments.

Polarbear captures reusable engineering evidence, distills durable knowledge, reconstructs task-specific context under a token budget, and checkpoints work across Codex and Claude Code sessions.

## Principles

- Do not carry unbounded conversation history; reconstruct bounded context.
- Preserve raw evidence, but inject only selected task-relevant context.
- Keep canonical state local and recoverable.
- Keep the core provider-neutral; isolate provider behavior in adapters.
- Treat recalled content as untrusted project data.
- Preserve existing Memory, CLI, MCP, and persisted-data compatibility.

## Current scope

Implemented capabilities include:

- the Option B Fact + Episode + Entity long-term-memory model;
- lifecycle, verification, supersession, retention, backup, and recovery;
- durable Tasks, Checkpoints, Execution Runs, Observations, and Context Packets;
- bounded, explainable context planning;
- assisted Claude Code hooks and common MCP integration;
- managed Codex and Claude Code CLI adapters behind an opt-in flag;
- deterministic session rotation and cross-provider handoff;
- Admin API management for Desktop;
- usage, retrieval, and logical context-efficiency metrics.

## Non-goals

- storing complete chat transcripts as durable memory;
- replacing provider-native compaction;
- making Desktop read or write `memory.db` directly;
- implicit telemetry, remote rendering, or default network access;
- a general-purpose workflow engine or autonomous multi-agent swarm.

## Roadmap

| Phase | Outcome | State |
|---|---|---|
| Memory foundation | Evidence, Knowledge, Entity, Relation, lifecycle, retrieval | Implemented |
| Context state | Task, Checkpoint, Execution Run, Context Packet | Implemented |
| Context planner | Priority categories, hard budget, provenance and explanation | Implemented |
| Provider integration | Claude hooks, common MCP, Codex/Claude managed adapters | Implemented |
| Rotation and handoff | Deterministic policy, checkpoint boundary, resume recovery | Implemented |
| Evaluation | Usage ledger, deterministic A/B/C fixtures, release gates | Implemented baseline |
| Multi-agent coordination | Parallel runs, conflict reconciliation, team policies | Deferred until real-project validation is stable |

Roadmap status describes engineering scope. Public release readiness is tracked separately in [Release readiness](./release-readiness.md).
