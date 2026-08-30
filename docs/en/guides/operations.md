# Operations, maintenance, and recovery

[简体中文](../../zh-CN/guides/operations.md)

## Diagnose

```bash
polarbear-memory status
polarbear-memory doctor
polarbear-memory doctor --export
```

Diagnostics exports exclude Memory content, repository paths, tokens, and raw session identifiers. Doctor returns a non-zero exit status when a configured Agent integration is stale, unlaunchable, conflicting, or fails the MCP handshake; an optional Agent that was never configured is reported but does not fail the command.

## Maintenance

Always preview lifecycle work when investigating behavior:

```bash
polarbear-memory maintain --dry-run
polarbear-memory maintain
```

Maintenance is bounded. It can reassess source anchors, archive eligible completed short-term state, and expire raw event buffers. Durable canonical knowledge is not automatically purged by age or low usage.

## Backup and restore

```bash
polarbear-memory backup create
polarbear-memory backup list
polarbear-memory backup verify /path/to/backup.db
polarbear-memory backup restore /path/to/backup.db --confirm /path/to/backup.db
```

Restore uses an explicit preview/confirmation boundary and preserves a rollback database. Close MCP, CLI, hook, and Desktop operations before exclusive maintenance or restore.

## Rebuild derived search state

```bash
polarbear-memory rebuild-index
```

Rebuilding FTS does not modify canonical Knowledge.

## Claude hook spool

If a hook cannot open the database, it writes a bounded local spool event. Replay it with:

```bash
polarbear-memory spool replay
```

## Remove integration or data

Preview before uninstalling:

```bash
polarbear-memory uninstall --dry-run
polarbear-memory uninstall --keep-data
```

Permanent deletion requires the explicit project confirmation shown by the CLI. Treat that path as destructive and take a verified backup first.

## Common failures

- **Project is not initialized:** run `polarbear-memory install` in the Git repository to initialize it and connect supported Agents.
- **Agent MCP runtime is stale:** run `polarbear-memory install` to repair every managed integration, or the Agent-specific installer to repair only that client.
- **Provider runtime unavailable:** install the official CLI and confirm it is on `PATH`.
- **Rotation requires a checkpoint:** save current structured state before requesting a fresh session.
- **Database busy:** close long-running clients; do not delete lock or lease files manually while a process is alive.
- **Admin API mismatch:** upgrade Engine and Desktop together; Desktop must not bypass the API by opening SQLite.
