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

Claude Code requires permission for MCP tool calls independently of server installation. The installer adds exact project-level allow rules for the 13 default Polarbear MCP tools, including `decision_record`, so routine Context OS operations do not prompt in every session or worktree. It preserves unrelated permission rules and does not use a wildcard: optional Admin tools and any future tools require an explicit review before they can be auto-approved.

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

`polarbear-memory doctor` checks configuration freshness, runtime and CLI existence, and an MCP initialization handshake using a minimal environment. The probe keeps stdin open until it receives the initialize response, then terminates the disposable child and waits for its stdio handles to close. This avoids racing the response against an EOF-triggered server shutdown and prevents orphan probes. Failures identify spawn, early exit, initialize timeout, protocol, I/O, or cleanup stages. A stale or missing runtime is a failure even when the configuration entry exists.

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

Claude lifecycle hooks perform routine retrieval, observation, turn distillation, and compaction checkpointing without model-selected MCP calls. MCP remains the explicit data/tool plane:

1. use `memory_search` for deeper historical investigation;
2. use Memory IDs for progressive expansion through `memory_get`;
3. use `context_get` or `context_explain` when the automatically injected packet needs explicit inspection or expansion;
4. use task and recording tools for intentional manual correction, compatibility mode, or providers without lifecycle control.

Stock Codex uses this MCP-assisted compatibility mode. The separately installed Polarbear App Server gateway is lifecycle-managed only for embedding clients whose complete JSONL stream passes through it; it must not change the capability claim for ordinary Codex CLI/Desktop sessions.

## Compatibility changes

A change to a tool name, required field, enum, or result contract is a public protocol change. Update the implementation tests and this behavioral overview. If the schema itself changes, the implementation source remains the single detailed definition.
