# Releasing

[简体中文](../../zh-CN/development/releasing.md)

## Source of truth

- package version and scripts: `package.json`;
- locked dependencies: `package-lock.json`;
- contracts: `api/admin-v1.json`, `api/admin-v1.types.ts`, and `api/runtime-launch-v1.json`;
- SBOM: `docs/SBOM.cdx.json`;
- release readiness policy: [Release readiness](../planning/release-readiness.md).

## Prepare

1. Confirm the working tree contains only intended changes.
2. Choose the release version and update package/lock/SBOM metadata together.
3. Confirm Admin API and generated Desktop contract compatibility.
4. Run release-time smoke checks against supported provider CLI versions.
5. Close applicable external readiness blockers.

## Automated gates

```bash
npm ci --ignore-scripts
npm run release:gates
npm pack --dry-run
```

The package audit enforces the publication allowlist. Do not rely only on `.gitignore` or `.npmignore`.

CI runs the runtime compatibility suite against the exact minimum Node `24.10.0`, the latest Node 24 patch, Node 25, and the latest Node 26 release. Linux covers every supported major; macOS and Windows cover the minimum and maximum boundaries. The suite covers CLI stderr policy, `node:sqlite` startup, structured launch generation, descriptor repair, legacy migration, paths with spaces, minimal-PATH MCP startup, and doctor diagnostics. Supporting a Node range does not mean testing every patch release, but every supported major and both declared boundaries must remain gated.

## npm publication

Publish only from the reviewed commit whose tag matches the package version:

```bash
npm publish --access public
```

Verify the registry metadata and install the exact published version in a clean environment. Never reuse an already published `name@version`.

## macOS package

Build an unsigned artifact for local verification:

```bash
npm run release:macos:unsigned
```

The public artifact requires configured Apple signing identity, installer signing, notarization, stapling, and verification:

```bash
npm run release:macos
```

Do not describe an unsigned or unnotarized build as a production-certified macOS release.

## Final consistency

Before pushing a tag, verify that:

- package version, Git tag, npm version, release notes, and SBOM agree;
- `npm run release:gates` passed on the release commit;
- the packed artifact contains no database, backup, log, secret, private business document, or test-only dependency;
- rollback and deprecation instructions are prepared for a failed release.
