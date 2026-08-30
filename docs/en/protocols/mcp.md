# MCP protocol

[简体中文](../../zh-CN/protocols/mcp.md)

## Role

MCP is the agent-facing compatibility surface. It exposes Memory and Context OS operations over stdio without giving clients direct database access.

The executable tool definitions, input schemas, descriptions, and result behavior are canonical in:

- `src/protocol-mcp/server.ts`;
- `src/protocol-mcp/context-os-tools.ts`.

Do not copy their complete JSON schemas into this document.

## Connect an Agent

Run the unified installer in the target repository:

```bash
cd /path/to/repository
polarbear-memory install
```

It initializes the project when needed and configures every currently supported Agent integration in one pass:

- Claude Code: `.mcp.json`, Agent rules, and lifecycle hooks;
- Codex: project-scoped `.codex/config.toml` and MCP server instructions.

Restart active Agent clients after installation. Existing unrelated configuration is preserved and managed changes are backed up. The Codex installer classifies a same-name entry as current managed, legacy managed, repairable Polarbear, or a foreign collision. Current entries are refreshed safely; legacy PATH-based entries from earlier releases and entries that clearly launch the installed Polarbear package are migrated automatically. Only an entry whose Polarbear ownership cannot be established is refused as an unmanaged collision. Re-running the installer is idempotent. Re-run it after moving or upgrading the active runtime. Use `polarbear-memory install --dry-run` for a non-mutating preview.

Other MCP-compatible clients can configure the same stdio server manually:

```json
{
  "command": "/absolute/path/to/the/current/node-runtime",
  "args": [
    "/absolute/path/to/polarbear-memory/dist/cli.js",
    "mcp",
    "--stdio",
    "--project-root",
    "/absolute/path/to/repository"
  ]
}
```

The runtime and CLI paths must belong to the same working Polarbear installation. The supported installers derive both paths from the running Polarbear process; they do not search shell profiles, runtime managers, or `PATH`. The client launches this process. A user does not normally run `polarbear-memory mcp --stdio` in a terminal or invoke the MCP tools manually.

`polarbear-memory doctor` checks configuration freshness, runtime and CLI existence, and an MCP initialization handshake using a minimal environment. A stale or missing runtime is a failure even when the configuration entry exists.

## Default tool groups

| Group | Tools |
|---|---|
| Legacy-compatible Memory | `memory_context`, `memory_get`, `memory_search`, `memory_record`, `memory_verify` |
| Context OS | `context_get`, `context_explain`, `task_create`, `task_get`, `task_checkpoint`, `decision_record`, `constraint_record`, `memory_feedback` |

When `--admin-tools` is explicitly enabled, the server also exposes `memory_status` and reversible `memory_forget`.

## Transport and safety

- The supported transport is MCP stdio.
- stdout contains protocol frames only; diagnostics belong on stderr.
- Input is validated and bounded before application-service calls.
- File paths must remain repository-relative and cannot escape through symlinks.
- Memory content is returned as untrusted project data.
- The server performs no implicit network access.
- Existing Memory tool names and behavior remain backward compatible.

## Context workflow

This workflow is performed by the Agent integration, not by the user during normal work:

1. Obtain a durable Task or create one with `task_create`.
2. Call `context_get` with the Task ID and current request.
3. Use Memory IDs for progressive expansion through `memory_get`.
4. Record durable decisions and constraints explicitly.
5. Persist structured state with `task_checkpoint` before handoff or rotation.
6. Use `context_explain` to inspect selection and exclusions.

## Compatibility changes

A change to a tool name, required field, enum, or result contract is a public protocol change. Update the implementation tests and this behavioral overview. If the schema itself changes, the implementation source remains the single detailed definition.
