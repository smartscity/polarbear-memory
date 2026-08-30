# Polarbear documentation

- [English documentation](./en/README.md)
- [简体中文文档](./zh-CN/README.md)

## Documentation ownership

The documentation tree follows the same single-responsibility rule as the codebase. Each fact has one owner:

| Fact | Canonical source |
|---|---|
| Product scope and roadmap | `docs/en/planning/` |
| System and subsystem design | `docs/en/architecture/` |
| MCP behavior | `docs/en/protocols/mcp.md`; executable schemas remain in `src/protocol-mcp/` |
| Admin API behavior | `docs/en/protocols/admin-api.md`; the contract remains `api/admin-v1.json` |
| Database schema | `src/storage/schema-v2.ts` |
| CLI surface | `polarbear-memory --help` and `src/cli.ts` |
| Repository/module ownership | `docs/en/implementation/repository-map.md` |
| Release commands and gates | `package.json` scripts |
| Dependency inventory | `package-lock.json` and `docs/SBOM.cdx.json` |

English engineering documentation is authoritative. `docs/zh-CN/` is the maintained Simplified Chinese translation set. A user-visible behavior change updates the owning English document and its Chinese counterpart; it does not require edits to every overview or index.

## Update rule

1. Change the canonical code or contract first.
2. Update the one English document that owns the changed behavior.
3. Update the matching Chinese translation when the behavior is user-visible.
4. Update an index only when navigation changes.
5. Do not copy complete CLI help, API capability lists, schemas, or test matrices into narrative documents.

Removed documents remain available in Git history. Historical plans are not kept in the active tree after their requirements have moved into code, tests, or an as-built design document.
