# macOS Installation and Release

## User installation and upgrade

Install the signed and notarized `.pkg` from the release page. The package places its immutable runtime under `/usr/local/lib/polarbear-memory` and a symlink at `/usr/local/bin/polarbear-memory`. Installing a newer package upgrades application files in place and does not touch the user-data directory or repository `.polarbear/knowledge`.

After installation:

```bash
polarbear-memory --version
cd /path/to/repository
polarbear-memory doctor
```

Before an upgrade, create and verify a project backup:

```bash
polarbear-memory backup create
polarbear-memory backup list
polarbear-memory backup verify memory-YYYY-MM-DD....db
```

The first Engine opening an older schema creates a migration backup before changing it. An older Engine refuses to write a database from a newer schema.

## Project uninstall

Preview and remove Claude integration while retaining Memory:

```bash
polarbear-memory uninstall --dry-run
polarbear-memory uninstall --keep-data
```

Data deletion is recoverable and requires the displayed project UUID:

```bash
polarbear-memory uninstall --delete-data --confirm PROJECT_UUID
```

This moves operational data into the Polarbear Memory user-data `trash` directory. It does not delete repository configuration or promoted Markdown.

## System package uninstall

Run `sudo scripts/uninstall-macos.sh` from the matching source/release support bundle. It removes only the fixed application paths and forgets package receipt `com.smartscity.polarbear-memory`. User data is preserved.

## Maintainer release

```bash
npm run release:check
APPLE_INSTALLER_IDENTITY='Developer ID Installer: …' \
APPLE_NOTARY_PROFILE='polarbear-memory' \
npm run release:macos
```

The build bundles the currently pinned Node runtime, production dependencies, licenses, Security Policy and CycloneDX SBOM. It signs the installer, submits it with `notarytool`, staples the ticket, validates signature/notarization, and writes a SHA-256 sidecar.

`release:macos:unsigned` exists only to validate package structure locally. Never publish an artifact whose filename contains `unsigned`.
