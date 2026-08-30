# Getting started

[简体中文](../../zh-CN/guides/getting-started.md)

## Requirements

- Node.js `>=24.10.0 <27`;
- npm;
- a Git repository;
- Codex or Claude Code.

## 1. Install the CLI

```bash
npm install --global polarbear-memory
```

## 2. Install Polarbear Memory in a project

Run the unified installer from the target repository:

```bash
cd /path/to/repository
polarbear-memory install
```

This single command:

- initializes the repository and local SQLite storage when needed;
- configures Claude Code MCP, Agent rules, and lifecycle hooks;
- configures project-scoped Codex MCP and server instructions;
- preserves unrelated configuration and backs up files before managed changes.

Restart active Agent clients after installation. Use `polarbear-memory install --dry-run` to preview without changing files.

## 3. Work normally

Use the Agent as usual. MCP tools and lifecycle hooks retrieve bounded context, preserve reusable knowledge, and checkpoint substantive work. They are Agent-facing operations; users do not invoke them manually during normal work.

After a safe checkpoint, close the current session and start a fresh one when the conversation becomes large. The new session resumes from durable task state and selected Memory rather than the complete old conversation.

## Verify

```bash
polarbear-memory doctor
```

For both `Claude MCP` and `Codex MCP`, the config, executable, and handshake lines should report `OK`. If a runtime upgrade makes an absolute path stale, run `polarbear-memory install` again to repair every supported Agent, or `polarbear-memory codex install` to repair Codex only.

## Next

- [MCP setup and Agent workflow](../protocols/mcp.md)
- [Context OS workflow](./context-os.md)
- [Memory Engine design](../architecture/memory-engine.md)
- [Operations and recovery](./operations.md)
