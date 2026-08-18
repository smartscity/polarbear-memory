# Security policy

## Supported version

Security fixes are provided for the latest `0.1.x` release candidate. Until the GA blockers in `docs/GA_READINESS.md` are closed, builds must be described as release candidates rather than production-certified GA artifacts.

## Reporting

Do not open a public issue containing credentials, private source code, Memory content, database files, or diagnostic bundles. Contact the repository maintainers privately and include only the minimum reproducible, redacted details. A public security contact must be configured before publishing the first release.

## Runtime guarantees

- Core is local-first and performs no active HTTP, HTTPS, TLS, DNS, `fetch`, telemetry, update check, remote image load, or remote PlantUML render.
- The Admin API uses a current-user Unix-domain socket; it does not listen on TCP.
- Memory content is untrusted data and is never executed.
- Canonical Memory is never physically purged by Agent or automatic-maintenance paths.
- Human physical purge requires Admin preview, an exact Memory-ID confirmation and a reason; it removes content while retaining only a one-way ID hash and non-content audit metadata.
- `memory.db` is owned exclusively by Memory Engine code. Polarbear Desktop uses the versioned Admin API.
- Database restore acquires an exclusive maintenance marker and refuses active Engine client leases. Desktop Native state accepts Memory requests only for its bound canonical workspace.

## Release requirements

Every release must pass the offline runtime test, source and bundle import audit, locked dependency allowlist, advisory gate, deterministic benchmark suite, SBOM freshness check, macOS signature verification, and notarization validation. Signing credentials must stay in the release environment and never enter the repository or Memory.
