# MCP protocol

[简体中文](../../zh-CN/protocols/mcp.md)

## Role

MCP is the agent-facing compatibility surface. It exposes Memory and Context OS operations over stdio without giving clients direct database access.

The executable tool definitions, input schemas, descriptions, and result behavior are canonical in:

- `src/protocol-mcp/server.ts`;
- `src/protocol-mcp/context-os-tools.ts`.

Do not copy their complete JSON schemas into this document.

## Connect an Agent

Initialize Polarbear Memory in the target repository before connecting a client:

```bash
cd /path/to/repository
polarbear-memory init
```

For Claude Code, install the managed MCP configuration, Agent rules, and lifecycle hooks once:

```bash
polarbear-memory claude install --dry-run
polarbear-memory claude install
```

Restart Claude Code after installation. The integration merges supported existing configuration and creates a backup before changing managed files.

For Codex or another MCP-compatible client, add this stdio server to the client's project configuration:

```json
{
  "command": "polarbear-memory",
  "args": ["mcp", "--stdio", "--project-root", "/absolute/path/to/repository"]
}
```

The client launches this process. A user does not normally run `polarbear-memory mcp --stdio` in a terminal or invoke the MCP tools manually.

## Default tool groups

| Group | Tools |
|---|---|
| Legacy-compatible Memory | `memory_context`, `memory_get`, `memory_search`, `memory_record`, `memory_verify` |
| Context OS | `context_get`, `context_explain`, `task_get`, `task_checkpoint`, `decision_record`, `constraint_record`, `memory_feedback` |

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

1. Obtain or create a durable Task through the Agent integration or Admin API.
2. Call `context_get` with the Task ID and current request.
3. Use Memory IDs for progressive expansion through `memory_get`.
4. Record durable decisions and constraints explicitly.
5. Persist structured state with `task_checkpoint` before handoff or rotation.
6. Use `context_explain` to inspect selection and exclusions.

## Compatibility changes

A change to a tool name, required field, enum, or result contract is a public protocol change. Update the implementation tests and this behavioral overview. If the schema itself changes, the implementation source remains the single detailed definition.
