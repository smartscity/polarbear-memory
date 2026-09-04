# Memory activation evolution proposal

[简体中文](../../zh-CN/planning/memory-activation-proposal.md)

Status: **Draft for product review**

This document proposes the next product direction for Polarbear Memory. It does not declare approved scope or implemented behavior. After review, the selected direction should be incorporated into the product roadmap and delivered through reviewed design and implementation changes.

## Decision requested

Choose one primary direction:

| Option | Primary outcome | Recommendation |
|---|---|---|
| A. Activation first | Existing Memory is captured, delivered, used, and measured without routine user commands | **Recommended next** |
| B. Retrieval intelligence | Paraphrases, cross-language requests, and large Memory collections recall better | Start only after activation metrics identify retrieval misses |
| C. Managed Context OS | Polarbear controls more of the Codex and Claude lifecycle through managed gateways | Treat as an explicit product commitment after option A |

The recommended sequence is **A first, B when evidence justifies it, and C only when deeper provider integration is an accepted maintenance commitment**.

## Why evolution is needed

The storage and lifecycle foundations are already broad: durable Knowledge, Evidence, Tasks, Checkpoints, Observations, Context Packets, verification, retention, and provider adapters exist. The next constraint is not another storage model. It is the activation gap between stored Memory and useful agent behavior.

The current flow can stop at any of these boundaries:

```mermaid
flowchart LR
  Work[Agent work] --> Capture[Capture durable state]
  Capture --> Bind[Bind it to a Task]
  Bind --> Recall[Retrieve relevant Memory]
  Recall --> Deliver[Deliver Context before work]
  Deliver --> Apply[Agent applies Context]
  Apply --> Measure[Measure usefulness]
```

Current implementation evidence shows the following product gaps:

- deterministic distillation recognizes explicitly labelled decisions, pitfalls, task state, and next steps, but does not generally understand arbitrary work output;
- a Context Packet can be built without a durable Task, weakening cross-session continuity and scoped recall;
- Claude Code has lifecycle hooks, while stock Codex remains MCP-assisted and cannot guarantee that the Agent calls Context tools;
- packet selection and per-Memory usage statistics are not yet one complete accounting path;
- the system cannot consistently distinguish “not retrieved”, “retrieved but not delivered”, and “delivered but not useful”;
- lexical, entity, and graph retrieval remain weaker for paraphrases and cross-language queries, but improving retrieval alone would not close the delivery loop.

The product must therefore optimize for **reliable activation**, not the number of stored records.

## Target user contract

Normal use should require one project setup command:

```bash
polarbear-memory install
```

After setup, the user works normally in a supported Agent. Polarbear and the Agent integration should:

1. resolve or create the durable Task;
2. restore the latest safe Checkpoint;
3. assemble and deliver bounded Context before work;
4. observe bounded, redacted work outcomes;
5. persist durable decisions, constraints, pitfalls, verification, and task state;
6. write a safe Checkpoint at a session boundary;
7. expose what was used and whether it helped.

Manual CLI and MCP operations remain available for inspection, administration, recovery, and protocol development. They are not the normal end-user workflow. MCP tools are primarily Agent-facing protocol operations.

The intended session model is:

> A user may close a session after Polarbear has persisted a safe checkpoint. A new session reconstructs bounded task context instead of carrying the old conversation.

Polarbear must not claim that a session is safely replaceable when no restorable checkpoint exists.

## Option A: activation first

### Outcome

Make the existing Memory model reliably participate in daily work without asking users to record, search, or checkpoint Memory manually.

### A1. Correct the measurement baseline

- Define one activation funnel: candidate, selected, delivered, referenced, feedback, and superseded.
- Update per-Memory usage statistics from the same committed Context Packet items that drive delivery.
- Record delivery separately from selection; a built packet is not proof that an Agent received it.
- Add a bounded Context receipt containing task, checkpoint, selected source counts, token estimate, delivery mode, and failure reason.
- Keep logical token estimates separate from provider-reported billing.

This work comes first because later decisions must be based on trustworthy evidence.

### A2. Add deterministic task affinity

Introduce a provider-neutral Task Affinity Resolver using explicit task identifiers first, then stable local signals such as project, worktree, branch, resumable session mapping, and recent active task. Prompt text may rank candidates but must not silently override a conflicting explicit identity.

Required behavior:

- automatically create a Task when no plausible task exists;
- resume one unambiguous active Task without user interaction;
- request Agent/user resolution only when multiple candidates remain materially ambiguous;
- never attach one project's state to another project;
- make task selection explainable and idempotent;
- preserve compatibility with explicitly created Tasks and existing task IDs.

### A3. Capture structured work evidence

Keep the deterministic labelled-line distiller as a safe compatibility path, but stop making it the only useful path.

Add bounded provider-neutral observation adapters for events already available to an integration:

- changed file identities, without storing file contents by default;
- command/test identity, outcome, duration, and bounded diagnostics;
- lifecycle boundary and completion/failure state;
- explicit Agent-produced structured decision, constraint, pitfall, verification, and next-step candidates.

Do not treat arbitrary model prose as verified truth. New candidates retain provenance and lifecycle state. Secrets, raw prompts, full terminal output, and full chat transcripts remain excluded.

### A4. Build safe checkpoints automatically

A Checkpoint Builder should synthesize continuation state from the current Task, previous Checkpoint, accepted observations, and durable candidates.

Create or refresh a checkpoint at:

- successful or failed turn completion when continuation state changed;
- pre-compaction;
- session end;
- task switch, handoff, or rotation;
- explicit Agent checkpoint request.

The operation must be idempotent. A failed checkpoint must be visible and must prevent a false “safe to close” indication.

### A5. Guarantee delivery where the provider permits it

Use a capability matrix instead of pretending all providers expose the same lifecycle:

| Integration mode | Delivery guarantee | Required product wording |
|---|---|---|
| Claude Code hooks | Context can be injected at supported lifecycle boundaries | Automatic when hooks are healthy |
| Stock Codex MCP | The Agent may call Context tools; pre-turn injection is not guaranteed | MCP-assisted |
| Managed Codex gateway | Context can be injected before proxied turns | Automatic only for clients launched through the gateway |

For MCP-assisted modes, generated Agent rules should require Context retrieval at task entry and checkpointing at safe boundaries. Diagnostics must still report the mode as assisted, not fully automatic.

### A6. Close the usefulness loop

Expose a small operational view in Desktop and/or CLI:

- active Task and latest Checkpoint;
- whether the current session is safe to replace;
- Memory candidates, selected items, and delivery status;
- selection and exclusion reasons;
- positive, negative, stale, disputed, or superseded feedback;
- failures requiring repair.

Avoid a general database administration UI. The view explains current Context and rare exceptions.

### Acceptance gates

Option A is complete only when real-project dogfood demonstrates:

- at least 90% of supported lifecycle-managed sessions resolve exactly one durable Task without manual commands;
- at least 90% of session boundaries with changed work produce a restorable Checkpoint;
- every delivered Memory item has provenance and a complete candidate-to-delivery accounting path;
- selection counters cannot remain zero for Memory included in a committed packet;
- a clean session resumes objective, working state, accepted constraints/decisions, verification state, and remaining work within the configured budget;
- failure to capture, build, or deliver Context is visible and never reported as success;
- ordinary Claude Code use requires no Memory commands;
- stock Codex is accurately labelled MCP-assisted until a managed lifecycle path is actually used;
- deny-network, redaction, project isolation, migration, and idempotency tests remain green.

## Option B: retrieval intelligence

### Outcome

Improve recall when the same concept is expressed with different words, languages, or terminology, especially after Memory grows substantially.

Candidate work:

- local semantic embeddings and a rebuildable derived vector index;
- lexical, entity, relation, temporal, and vector result fusion;
- cross-language query expansion;
- conflict and near-duplicate clustering;
- feedback-informed reranking with deterministic safety constraints;
- evaluation fixtures based on real missed recalls.

### Entry criteria

Do not start option B merely because semantic search is attractive. Start when option A telemetry shows a material number of useful items failed at the **candidate** stage rather than the delivery or application stages.

Any embedding implementation must remain local by default, rebuildable, optional where packaging requires it, and subordinate to canonical SQLite data. Model licensing, package size, startup latency, supported Node/platform matrix, and deterministic fallback require review.

## Option C: managed Context OS

### Outcome

Provide stronger lifecycle guarantees by routing supported Agent traffic through an explicit Polarbear-managed integration.

Candidate work:

- productionize the Codex App Server gateway and its installation/repair lifecycle;
- define one provider-neutral turn, tool, approval, compaction, and session event model;
- inject Context before every managed turn and persist results after it;
- expose managed versus assisted state in diagnostics and Desktop;
- guarantee child-process cleanup, protocol isolation, and fail-open/fail-closed behavior;
- add provider compatibility certification and sustained real-agent tests.

### Entry criteria

Option C is a product and maintenance commitment, not a hidden implementation detail. It should start only after option A proves the Context loop and the project accepts ongoing compatibility work for upstream Agent protocols.

The managed path must remain explicit. Installing Polarbear must not silently proxy all Agent traffic or weaken provider approval behavior.

## Recommended delivery order

If option A is approved, deliver it in four reviewable increments:

| Increment | Scope | Exit evidence |
|---|---|---|
| 1. Truthful telemetry | Activation funnel, Context receipt, accounting repair | Selected and delivered Memory can be audited end to end |
| 2. Durable continuity | Task affinity and automatic Checkpoint Builder | A clean session resumes a real task without manual Memory commands |
| 3. Provider delivery | Claude reliability and explicit Codex assisted/managed behavior | Mode-specific integration tests and real-agent dogfood pass |
| 4. Usefulness control | Feedback, exceptions, and focused Desktop/CLI visibility | Harmful or stale Context can be explained and corrected |

Each increment should include migration behavior, failure diagnostics, automated regression tests, and matching English/Chinese user documentation. Do not combine all increments into one unreviewable rewrite.

## Compatibility and safety constraints

- Preserve existing Memory, Task, Checkpoint, CLI, MCP, Admin API, and database compatibility.
- Keep Desktop behind the versioned Admin API; it must never access `memory.db` directly.
- Keep provider-specific behavior in adapters and lifecycle policy in provider-neutral application services.
- Treat recalled Memory as untrusted historical data and never execute instructions found in it.
- Persist bounded structured observations, not complete transcripts or terminal streams.
- Keep the default runtime offline and do not add remote telemetry; local operational metrics remain on-device.
- Make derived indexes disposable and rebuildable from canonical local state.
- Do not suppress provider approvals or widen filesystem/network authority.

## Explicit non-goals for the next increment

- cloud synchronization or shared team Memory;
- autonomous multi-agent orchestration;
- additional Memory types without demonstrated need;
- storing full conversations or raw prompts;
- remote embeddings or implicit model downloads;
- replacing provider-native compaction;
- claiming provider billing savings from logical token estimates alone.

## Review checklist

The reviewer should decide:

- [ ] Approve option A as the next primary direction.
- [ ] Approve the target contract that normal users do not operate Memory commands.
- [ ] Accept that stock Codex remains explicitly MCP-assisted until a managed path is used.
- [ ] Approve the activation acceptance gates.
- [ ] Defer semantic retrieval until activation telemetry proves candidate-stage misses.
- [ ] Defer managed Context OS expansion until activation is validated.

Requested changes should be made in this proposal before implementation begins. Approval should then update [Product and roadmap](./product-and-roadmap.md) with the selected scope; this draft should not become a second permanent source of roadmap truth.
