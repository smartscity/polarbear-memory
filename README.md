# Polarbear Memory

Local-first persistent memory for coding agents. MVP-3 adds trust and lifecycle governance to automatic local handoff: source changes produce warnings, completed short-term knowledge leaves normal Context, superseded knowledge stops competing with its replacement, and canonical Memory is never automatically purged.

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
- An explicit `[completed]` or `[cancelled]` marker on `Task state:` / `Next step:` makes the item leave normal Context immediately; completion is never guessed.
- Repeated hook delivery is idempotent. A newer automatic `TASK_STATE` supersedes the previous active state on the same Git branch.
- Full transcripts are never read. Credentials and home paths are redacted before raw events are persisted; raw events expire after seven days.
- `fixtures/automatic-handoff/fixture.json` is the deterministic 10-session capture gate (10/10 currently useful; release threshold is at least 80%).

## MVP-3 trust, stale detection, and retention

- `maintain --dry-run [--limit N]`: preview a bounded lifecycle plan without changing Memory.
- `maintain [--limit N]`: apply source-risk, relevance, short-term archive, raw retention, cursor, and audit updates transactionally.
- `complete MEMORY_ID --result completed|cancelled --reason TEXT`: immediately remove a finished `TASK_STATE` or `TODO` from normal Context; it becomes eligible for reversible archive after seven days.
- `restore MEMORY_ID --reason TEXT`: restore an archived Memory and protect it from the same automatic archive rule for 30 days.
- `feedback MEMORY_ID --result useful|not-useful --reason TEXT`: provide an explicit bounded utility signal; selection counts alone never prove correctness.
- `relate SOURCE_ID --type supersedes|contradicts --target TARGET_ID --reason TEXT`: preserve explicit replacement or conflict history. Contradictions become warnings rather than silent winners.
- File-backed Memory stores a normalized local content digest. A changed/missing anchor becomes a HIGH-risk Context Warning until `verify` checks current evidence and re-anchors it.
- Usage statistics and relevance are independent of correctness. Old `DECISION` and `PITFALL` records are not archived merely because they are old or rarely selected.
- `benchmark fixtures/retention-180d/fixture.json` runs deterministic No Retirement, Naive TTL, and Four-Layer treatments with a controllable 180-day clock.
- `benchmark fixtures/security/malicious-memory.json` verifies that prompt-injection text remains quoted, explicitly untrusted data.

`memory_context` and session finalization run bounded maintenance on a best-effort basis. Maintenance failures never block context delivery or Claude Code shutdown. All lifecycle changes retain revision and assessment reasons; no CLI, MCP, hook, or maintenance code path exposes automatic canonical purge.

Claude Code project MCP servers require a one-time user approval. The generated configuration launches `polarbear-memory` from `PATH`; source checkouts should run `npm link` first or pass `claude install --command /absolute/path/to/a/release-launcher`.

Runtime code uses only the official MCP stdio server SDK and Zod in addition to Node built-ins. The tested runtime path performs no network requests, including diagram or rendering services. Project repositories contain configuration and Claude integration files only; `memory.db` is owned by the Memory Engine and stored in the operating system's user-data directory.

See [PRD](docs/PRD.md), [TRD](docs/TRD.md), [User Manual](docs/USER_MANUAL.md), and [Memory Retention Validation](docs/MEMORY_RETENTION_VALIDATION.md).
