# Polarbear Memory

Local-first persistent memory for coding agents. The current implementation is MVP-0: a manual CLI loop for recording structured project knowledge and compiling a small, source-aware Context Pack.

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

Runtime code has no third-party dependencies and performs no network requests. Project repositories contain only `.polarbear/config.toml`; `memory.db` is owned by the Memory Engine and stored in the operating system's user-data directory.

See [PRD](docs/PRD.md), [TRD](docs/TRD.md), [User Manual](docs/USER_MANUAL.md), and [Memory Retention Validation](docs/MEMORY_RETENTION_VALIDATION.md).
