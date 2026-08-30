import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "polarbear-memory-package-audit-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const failures = [];

function packManifest() {
  const result = spawnSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(temporaryRoot, "npm-cache") },
  });
  if (result.status !== 0) throw new Error(`npm pack --dry-run failed:\n${result.stderr || result.stdout}`);
  const manifests = JSON.parse(result.stdout);
  if (!Array.isArray(manifests) || manifests.length !== 1) throw new Error("npm pack returned an unexpected manifest.");
  return manifests[0];
}

try {
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifest = packManifest();
  const paths = new Set((manifest.files ?? []).map((file) => file.path));
  const required = new Set([
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "api/admin-v1.json",
    "api/runtime-launch-v1.json",
    "dist/cli.js",
    "package.json",
  ]);
  const allowedRootFiles = new Set(required);

  for (const path of required) {
    if (!paths.has(path)) failures.push(`required file is missing: ${path}`);
  }
  for (const path of paths) {
    const allowedRuntime = path.startsWith("dist/") && path.endsWith(".js");
    if (!allowedRootFiles.has(path) && !allowedRuntime) failures.push(`file is outside the publication allowlist: ${path}`);
    if (/(^|\/)(?:src|test|tests|fixtures|scripts|docs|\.business|\.github)(\/|$)/u.test(path)) {
      failures.push(`internal directory leaked into package: ${path}`);
    }
    if (/(?:\.test\.js|\.map|\.d\.ts|\.env|\.db|\.sqlite|\.pem|\.key)$/u.test(path)) {
      failures.push(`forbidden artifact leaked into package: ${path}`);
    }
  }

  const expectedFiles = ["dist", "api/admin-v1.json", "api/runtime-launch-v1.json", "README.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "LICENSE"];
  if (JSON.stringify(metadata.files) !== JSON.stringify(expectedFiles)) failures.push("package.json files allowlist changed.");
  if (metadata.private !== false) failures.push("package.json private must be false.");
  if (metadata.license !== "Apache-2.0") failures.push("package.json license must be Apache-2.0.");
  if (metadata.bin?.["polarbear-memory"] !== "dist/cli.js") failures.push("package.json bin target changed.");
  if (metadata.publishConfig?.access !== "public") failures.push("publishConfig.access must be public.");
  if (metadata.publishConfig?.registry !== "https://registry.npmjs.org/") failures.push("publishConfig.registry must be the official npm registry.");
  if (!readFileSync(join(root, "dist", "cli.js"), "utf8").startsWith("#!/usr/bin/env node\n")) {
    failures.push("dist/cli.js is missing its Node.js shebang.");
  }
  if ((manifest.unpackedSize ?? Number.POSITIVE_INFINITY) > 2 * 1024 * 1024) {
    failures.push(`unpacked package exceeds 2 MiB: ${manifest.unpackedSize} bytes`);
  }

  if (failures.length > 0) throw new Error(`npm publication policy rejected:\n${failures.join("\n")}`);
  console.log(`npm publication policy OK: ${paths.size} allowlisted files, ${manifest.unpackedSize} unpacked bytes.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
