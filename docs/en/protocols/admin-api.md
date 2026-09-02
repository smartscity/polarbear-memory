# Local Admin API

[简体中文](../../zh-CN/protocols/admin-api.md)

## Role

The Admin API is the complete management boundary used by Polarbear Desktop and other local control-plane clients. Desktop never opens `memory.db` directly.

The canonical published contract is [`api/admin-v1.json`](../../../api/admin-v1.json). Canonical TypeScript DTOs are [`api/admin-v1.types.ts`](../../../api/admin-v1.types.ts). This document explains the architecture and compatibility rules, not every method field.

## Transport

- user-scoped Unix-domain socket;
- no TCP listener;
- service directory mode `0700`;
- socket and token file mode `0600`;
- bounded UTF-8 JSON-line frames;
- constant-time token comparison;
- database paths and local secrets omitted from responses.

## Capability families

The contract currently covers:

- system version/capability negotiation;
- project status, diagnostics, and configuration;
- complete Memory CRUD, explicit human rejection, lifecycle, relation, feedback, and purge preview;
- context compilation, latest-packet retrieval, and explanation;
- Task creation, checkpoint history, execution history, and run context;
- persisted agent connection/activity summaries plus managed Codex and Claude Code configuration, runtime, handshake health, lifecycle capability, effective integration mode, and repair;
- observation distillation, Context OS usage metrics, and lifecycle counters/latency;
- maintenance preview/application;
- backup list, create, verify, restore preview, and restore;
- durable knowledge promotion preview/application.

Read the capability array in `api/admin-v1.json` for the exact current list.

## Versioning

- `system.hello` returns API version, Engine version, transport, and capabilities.
- Clients negotiate capabilities instead of assuming every method exists.
- A breaking contract change requires a major API version.
- Additive minor changes update the canonical JSON/types, router, tests, and generated Desktop contract together.
- `npm run admin-contract:check` rejects drift.

## Ownership boundary

The protocol router parses requests, authorizes them, calls application services, and formats DTOs. Database transactions, validation, migration, and lifecycle rules remain Engine responsibilities.
