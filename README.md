# Polarbear Memory

Local-first persistent memory for coding agents. v0.1 hardens the Claude-first product with verified backup/restore, safe uninstall, diagnostics, deterministic GA benchmarks, SBOM and a signed/notarized macOS release pipeline. The current readiness status is **release candidate**, not public GA; see [GA Readiness](docs/GA_READINESS.md).

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

## v0.1 operations

- `backup create|list|verify FILE`: create and validate SQLite-consistent backups.
- `backup restore FILE`: preview a restore; confirmation requires the exact displayed filename. The previous operational database is retained as a rollback backup.
- `doctor --export`: write a `0600` structured diagnostic report without Memory content, repository path, database path, branch/commit values, environment variables, or credentials.
- `uninstall --dry-run`: preview removal of managed Claude integration entries.
- `uninstall --keep-data`: remove managed integration while retaining all Memory data.
- `uninstall --delete-data --confirm PROJECT_ID`: move project data into recoverable user-data trash; repository config and promoted Markdown remain untouched.
- `savings`: show locally accumulated estimated token savings from bounded Context compilation; `savings reset --confirm RESET` starts a new measurement window without changing Memory.
- `npm run benchmark:ga`: execute deterministic resume, retention, and hostile-content release fixtures.
- `npm run package:check`: build the npm-only runtime, audit the exact tarball allowlist, install the `.tgz` in a temporary directory and smoke-test the CLI.
- `npm run release:macos`: build, sign, notarize, staple and verify the macOS `.pkg`; protected Apple credentials are mandatory.
- `npm run release:macos:unsigned`: local packaging validation only and never a publishable artifact.

## MVP-0 commands

- `init [--dry-run]`
- `record --type DECISION|PITFALL|TASK_STATE|TODO --summary TEXT`
- `search QUERY [--limit N]`
- `get MEMORY_ID`
- `context --task TEXT [--budget N]`
- `status`
- `savings [show|reset --confirm RESET]`
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

## MVP-4 Polarbear Desktop control plane

- `service run`: starts Admin API v1 on a current-user Unix-domain socket. It never listens on TCP; the service directory is `0700`, and the socket/token are `0600`.
- The versioned API supports capability negotiation, project overview, timeline/search/detail, auditable content edits, verify/dispute, reversible archive/restore, approved physical purge, Context Pack explanation, project policy, maintenance, backup/restore, service shutdown, and two-phase Promote to Markdown.
- Promote first returns inert source text, target path, and SHA-256. The confirmed write must present the same SHA-256 and uses exclusive creation, so it neither silently changes after preview nor overwrites an existing file.
- Polarbear Desktop holds no database code or token in its webview. Its Rust backend binds the canonical current workspace, validates current-user ownership and permissions, then proxies an allowlisted, size-bounded request.
- Database restore uses an exclusive maintenance marker plus per-process client leases. It refuses an active writer, preserves a rollback backup, and never asks Desktop to manipulate `memory.db`.
- The Memory panel renders content with React text nodes and `<pre>` only: no HTML execution, remote image loading, fenced-code execution, or PlantUML rendering.
- macOS and Linux are the runnable MVP-4 transport target. Windows named-pipe support remains a post-MVP portability item.

Claude Code project MCP servers require a one-time user approval. The generated configuration launches `polarbear-memory` from `PATH`; source checkouts should run `npm link` first or pass `claude install --command /absolute/path/to/a/release-launcher`.

Runtime code uses only the official MCP stdio server SDK and Zod in addition to Node built-ins. `node:net` is isolated to the audited Unix-domain-socket module; HTTP, HTTPS, TLS, DNS and `fetch` remain forbidden in the Engine release. Project repositories contain configuration, integration files, and explicitly promoted Markdown only; `memory.db` is owned by the Memory Engine and stored in the operating system's user-data directory.

See [PRD](docs/PRD.md), [TRD](docs/TRD.md), [User Manual](docs/USER_MANUAL.md), [npm Release Guide](docs/NPM_RELEASE.md), and [Memory Retention Validation](docs/MEMORY_RETENTION_VALIDATION.md).

## License

Polarbear Memory is licensed under the [Apache License 2.0](LICENSE).
