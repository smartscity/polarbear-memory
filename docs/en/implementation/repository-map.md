# Repository and implementation map

[简体中文](../../zh-CN/implementation/repository-map.md)

## Source layout

| Path | Responsibility |
|---|---|
| `src/domain/` | Provider- and storage-neutral domain types and invariants |
| `src/application/` | Use cases, planning, finalization, maintenance, benchmarks, and ports |
| `src/storage/` | SQLite repositories, schema, migration, indexes, and compatibility facade |
| `src/runtime/` | Provider-neutral runtime contract, routing, session management, and rotation policy |
| `src/adapters/` | Claude Code and Codex-specific integration |
| `src/protocol-mcp/` | Agent-facing MCP adapter |
| `src/protocol-local/` | Local Admin API transport and router |
| `src/cli/` and `src/cli.ts` | Human-facing command adapter |
| `src/platform/` | Git, project identity, and file-anchor integration |
| `src/security/` | Redaction and trust-boundary helpers |
| `api/` | Versioned Admin API contract and DTO source |
| `fixtures/` | Deterministic benchmark and security fixtures |
| `scripts/` | Build, audit, packaging, SBOM, and release gates |

## Core ownership

- `SqliteMemoryStore` is a compatibility facade, not a home for new business algorithms.
- Repositories own one aggregate or persistence capability.
- Application services own one use case and depend on ports.
- Protocol adapters do not expose database rows.
- Provider-specific behavior stays below `src/adapters/<provider>/`.
- Transaction ownership sits at public write-operation boundaries through `inImmediateTransaction`.
- Memory aggregate row mapping is centralized in `memory-read-model.ts`.
- FTS is managed only by `KnowledgeSearchIndex` and remains rebuildable.

## Where to make a change

| Change | Primary code | Owning document |
|---|---|---|
| Memory type/invariant | `src/domain/memory.ts` | `architecture/memory-engine.md` |
| Schema/migration | `src/storage/schema-v2.ts` | `architecture/memory-engine.md` |
| Context selection | `src/application/context-planner.ts` | `architecture/context-os.md` |
| Rotation/runtime | `src/runtime/`, `src/adapters/` | `architecture/context-os.md` |
| MCP tool | `src/protocol-mcp/` | `protocols/mcp.md` |
| Admin method/DTO | `api/`, `src/protocol-local/` | `protocols/admin-api.md` |
| CLI behavior | `src/cli.ts`, `src/cli/` | relevant guide only |
| Release gate | `package.json`, `scripts/` | `development/releasing.md` |

This routing table replaces the old rule requiring every architecture change to edit a monolithic TRD, a UML supplement, README, and user manual simultaneously.
