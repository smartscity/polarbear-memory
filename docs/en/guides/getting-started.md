# Getting started

[简体中文](../../zh-CN/guides/getting-started.md)

## Requirements

- Node.js in the range declared by `package.json`;
- npm;
- a Git repository;
- Codex or Claude Code only if you want the corresponding provider integration.

## Install

```bash
npm install --global polarbear-memory
polarbear-memory --version
```

## Initialize a repository

```bash
cd /path/to/repository
polarbear-memory init --dry-run
polarbear-memory init
```

Initialization creates `.polarbear/config.toml`. The SQLite database is stored in the current user's Polarbear data directory, not committed to the repository.

## Record and retrieve Memory

```bash
polarbear-memory record \
  --type DECISION \
  --summary "Use the local Admin API" \
  --content "Desktop must never open memory.db directly"

polarbear-memory search "Desktop database boundary"
polarbear-memory context --task "continue Desktop integration" --budget 1000
```

Use `polarbear-memory --help` for the complete current command surface. The CLI help is authoritative; this guide shows only common workflows.

## Enable MCP

Connect Claude Code, Codex, or another MCP-compatible Agent once, then use the Agent normally. See [MCP setup and protocol](../protocols/mcp.md) for the owned setup commands, client configuration, tool groups, and safety rules.

## Verify and maintain

```bash
polarbear-memory verify MEMORY_ID --result VERIFIED --reason "Confirmed by current code and tests"
polarbear-memory maintain --dry-run
polarbear-memory maintain
polarbear-memory doctor
polarbear-memory backup create
```

Maintenance never silently purges durable knowledge merely because it is old. See [Operations](./operations.md).

## Next

- [Context OS workflow](./context-os.md)
- [Memory Engine design](../architecture/memory-engine.md)
- [Troubleshooting and recovery](./operations.md)
