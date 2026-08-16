# Polarbear Memory v0.1 GA Readiness

Status: **Release candidate — not yet eligible for the GA label**

The engineering implementation is versioned `0.1.0`, but public GA requires both automated gates and external evidence. Version number and readiness status are intentionally separate.

## Automated gates

| Gate | Command | Required result |
| --- | --- | --- |
| Formatting and static policy | `npm run format:check && npm run lint` | pass |
| Domain/storage/protocol/e2e | `npm test` | pass |
| Runtime dependency and licenses | `npm run licenses:check && npm run dependencies:check` | pass |
| Source/release zero-egress audit | `npm run bundle:audit` | pass |
| SBOM drift | `npm run sbom:check` | pass |
| Deterministic GA fixtures | `npm run benchmark:ga` | pass |
| High/critical advisories | `npm run advisories:check` | zero high/critical |
| Clean installation | `npm run release:check` | pass from `npm ci --ignore-scripts` |
| macOS artifact | `npm run release:macos` | signed, notarized, stapled and signature-verified |

The deterministic resume fixture requires ≥30% fewer pre-edit file reads and ≥40% fewer oracle-modelled rediscovery tokens. This is a regression gate, not a substitute for a real Agent/model benchmark.

## External GA blockers

- Run the PRD-controlled baseline/treatment suite with a fixed real Agent/model and demonstrate ≥40% median repeated-exploration token reduction, ≥30% median time-to-first-action reduction and no task-success regression.
- Complete two consecutive weeks of dogfood with no unresolved P0/P1 data-loss or security defect.
- Configure a private security contact and incident-response owner.
- Produce the macOS package using the protected Apple Developer Installer identity and notary profile; retain notarization and checksum evidence.
- Review the project licensing decision. The repository remains `UNLICENSED`; publishing or redistribution is blocked until the chosen license texts and package metadata are approved.

## Honest release decision

Do not tag or announce GA while any external blocker remains. Automated success permits an internal `v0.1.0-rc` artifact only.
