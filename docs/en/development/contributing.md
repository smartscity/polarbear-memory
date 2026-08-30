# Contributing

[简体中文](../../zh-CN/development/contributing.md)

## Before changing code

Read:

1. [`AGENTS.md`](../../../AGENTS.md)
2. [Architecture overview](../architecture/overview.md)
3. [Repository map](../implementation/repository-map.md)
4. the one subsystem document that owns your change.

Do not assume a monolithic PRD/TRD is current. The active documentation tree is organized by responsibility.

## Development setup

```bash
npm install
npm run typecheck
npm test
```

Use the Node range and exact dependencies declared in `package.json` and `package-lock.json`.

## Design rules

- Preserve unrelated user changes.
- Keep `protocol-* -> application -> domain` dependency direction.
- Keep Desktop behind the Admin API.
- Keep provider-specific behavior in adapters.
- Keep canonical data local and derived indexes rebuildable.
- Use the shared immediate-transaction boundary for writes.
- Validate and bound every external `unknown` input.
- Add a regression test before or with a bug fix.
- Do not add implicit network access, telemetry, or remote rendering.

## Documentation rule

For a behavior change:

1. update code or the canonical contract;
2. update one owning English document;
3. update its Chinese counterpart if user-visible;
4. leave stable indexes and unrelated architecture documents unchanged.

Detailed schemas remain in code/contracts. Narrative documents explain intent, boundaries, and workflow.

## Tests

At minimum for production changes:

```bash
npm run typecheck
npm test
```

Before release:

```bash
npm run release:gates
```

See `package.json` for the authoritative gate graph.

## Change review

- Is the change in the owning layer?
- Are transactions, project isolation, idempotency, and failure recovery covered?
- Does it preserve protocol and persisted-data compatibility?
- Are recalled or external values still treated as untrusted?
- Did the change update only its owning document and required translation?
- Does `git diff --check` pass, and are unrelated files untouched?
