# Polarbear Memory

Local-first persistent memory for coding agents. MVP-2 adds automatic, local handoff capture to the manual CLI and MCP resume loop: Claude Code lifecycle hooks retain only a redacted final-message envelope, then finalize reusable labeled decisions, pitfalls, task state, and next steps when the session ends.

## Requirements

- Node.js 24.10 or newer (the release target is pinned in `.node-version`)
- Git

## Build and run

```bash
npm install --ignore-scripts
npm run build
npm link

cd /path/to/a/git/project
polarbear-memory init
polarbear-memory record --type PITFALL --summary "Do not retry inside the transaction" --file src/a.ts
polarbear-memory search "retry transaction"
polarbear-memory context --task "continue settlement recovery" --budget 1000

# Preview, then install the Claude Code integration
polarbear-memory claude install --dry-run
polarbear-memory claude install
```

For development without `npm link`, use `node /path/to/polarbear-memory/dist/cli.js`.

## MVP-0 commands

- `init [--dry-run]`
- `record --type DECISION|PITFALL|TASK_STATE|TODO --summary TEXT`
- `search QUERY [--limit N]`
- `get MEMORY_ID`
- `context --task TEXT [--budget N]`
- `status`
- `doctor`
- `rebuild-index`
- `backup`
- `benchmark fixtures/resume-basic/fixture.json`

## MVP-1 commands

- `mcp --stdio [--project-root PATH]`: start the default five-tool Agent server.
- `mcp --stdio --admin-tools`: additionally expose diagnostic `memory_status` and reversible `memory_forget`.
- `claude install [--dry-run]`: merge `.mcp.json`, install the minimal rule and local lifecycle hooks, and back up all affected files.
- `claude restore`: restore the most recent pre-install Claude configuration.
- `verify MEMORY_ID --result VERIFIED|DISPUTED|UNVERIFIED --reason TEXT`.
- `forget MEMORY_ID --reason TEXT`: archive only; never physically purge.
- `benchmark fixtures/resume-10/fixture.json`: run the deterministic 10-session resume suite.

## MVP-2 automatic handoff

- `hook ingest --event Stop|SessionEnd`: bounded, silent Claude Code hook entry point. It is installed automatically by `claude install` and is not normally run by hand.
- `spool replay`: replay locally spooled hook events after a temporary database failure.
- Automatic extraction accepts only concise lines labeled `Decision:`, `Pitfall:`, `Task state:`, or `Next step:` (Chinese labels are also supported).
- Repeated hook delivery is idempotent. A newer automatic `TASK_STATE` supersedes the previous active state on the same Git branch.
- Full transcripts are never read. Credentials and home paths are redacted before raw events are persisted; raw events expire after seven days.
- `fixtures/automatic-handoff/fixture.json` is the deterministic 10-session capture gate (10/10 currently useful; release threshold is at least 80%).

Claude Code project MCP servers require a one-time user approval. The generated configuration launches `polarbear-memory` from `PATH`; source checkouts should run `npm link` first or pass `claude install --command /absolute/path/to/a/release-launcher`.

Runtime code uses only the official MCP stdio server SDK and Zod in addition to Node built-ins. The tested runtime path performs no network requests, including diagram or rendering services. Project repositories contain configuration and Claude integration files only; `memory.db` is owned by the Memory Engine and stored in the operating system's user-data directory.

See [PRD](docs/PRD.md), [TRD](docs/TRD.md), [User Manual](docs/USER_MANUAL.md), and [Memory Retention Validation](docs/MEMORY_RETENTION_VALIDATION.md).
