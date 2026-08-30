# Release readiness

[简体中文](../../zh-CN/planning/release-readiness.md)

Engineering completion and public release certification are separate decisions.

## Automated evidence

The release gate is:

```bash
npm run release:gates
```

It owns the executable definition of required formatting, type checking, contract drift checks, tests, license and dependency policy, bundle inspection, SBOM consistency, benchmark gates, advisory checks, and npm package smoke tests. Do not duplicate the command graph here; `package.json` is authoritative.

## External evidence

The following cannot be proven by a repository-only test:

- representative token and usage measurements from fixed real provider/model runs;
- sustained dogfood without a P0/P1 data-loss or security defect;
- release-time smoke checks against the installed supported Codex and Claude Code CLIs;
- Apple signing and notarization for a public macOS package;
- availability of required release credentials and registry identities.

## Decision rule

- Automated gates failing: not releasable.
- Automated gates passing but external evidence incomplete: release-candidate quality only.
- Automated and applicable external evidence complete: eligible for the planned public release.

The package version comes from `package.json`. Git tags, npm versions, release notes, and SBOM metadata must agree before publication.
