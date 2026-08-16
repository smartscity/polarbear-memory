# Third-party notices

Polarbear Memory v0.1 uses a deliberately small third-party runtime surface:

| Package | Version | License | Distribution role |
| --- | --- | --- | --- |
| `@modelcontextprotocol/server` | 2.0.0 | MIT | MCP server and stdio transport |
| `@modelcontextprotocol/core` | 2.0.0 | MIT | Transitive MCP protocol types/runtime |
| Zod | 4.2.0 | MIT | MCP boundary validation |

The development toolchain is pinned in `package-lock.json`:

| Package | Version | License | Distribution role |
| --- | --- | --- | --- |
| TypeScript | 5.9.3 | Apache-2.0 | Development only |
| `@types/node` | 24.10.1 | MIT | Development only |
| `undici-types` | 7.16.0 | MIT | Transitive development only |

The test-only official MCP client and its transitive dependencies are recorded in `package-lock.json`. They are development dependencies and must not enter the release runtime bundle.

The macOS package includes the pinned Node.js runtime. Node.js is distributed under the MIT license and contains additional third-party software and notices from its official distribution. Release review must preserve the Node runtime's accompanying license obligations; the generated CycloneDX inventory is available at `docs/SBOM.cdx.json`.

This list was derived from the installed package metadata and must be regenerated and reviewed whenever the lockfile changes. Release packaging must preserve the license notices for runtime dependencies and exclude test-only client dependencies.

The Polarbear Memory project itself is currently marked `UNLICENSED` while the proposed `MIT OR Apache-2.0` licensing decision remains under review. Do not publish or redistribute it as an open-source package until that decision is explicitly accepted and the corresponding license texts are added.
