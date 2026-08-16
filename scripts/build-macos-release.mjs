import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const unsigned = process.argv.includes("--unsigned");
if (process.platform !== "darwin") throw new Error("The v0.1 release artifact is supported only on macOS.");
const signingIdentity = process.env.APPLE_INSTALLER_IDENTITY;
const notaryProfile = process.env.APPLE_NOTARY_PROFILE;
if (!unsigned && (!signingIdentity || !notaryProfile)) {
  throw new Error("Signed release requires APPLE_INSTALLER_IDENTITY and APPLE_NOTARY_PROFILE. Use --unsigned only for local validation.");
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

run("npm", ["run", "build"]);
run("npm", ["run", "sbom:check"]);
const temporary = mkdtempSync(join(tmpdir(), "polarbear-memory-release-"));
const payload = join(temporary, "payload");
const installRoot = join(payload, "usr", "local", "lib", "polarbear-memory");
const binRoot = join(payload, "usr", "local", "bin");
const artifacts = join(root, "artifacts");
mkdirSync(join(installRoot, "runtime"), { recursive: true, mode: 0o755 });
mkdirSync(join(installRoot, "node_modules", "@modelcontextprotocol"), { recursive: true, mode: 0o755 });
mkdirSync(binRoot, { recursive: true, mode: 0o755 });
mkdirSync(artifacts, { recursive: true, mode: 0o755 });
copyFileSync(process.execPath, join(installRoot, "runtime", "node"));
chmodSync(join(installRoot, "runtime", "node"), 0o755);
cpSync(join(root, "dist"), join(installRoot, "dist"), { recursive: true });
for (const dependency of ["zod", "@modelcontextprotocol/core", "@modelcontextprotocol/server"]) {
  cpSync(join(root, "node_modules", dependency), join(installRoot, "node_modules", dependency), { recursive: true });
}
for (const file of ["package.json", "THIRD_PARTY_NOTICES.md", "SECURITY.md"]) copyFileSync(join(root, file), join(installRoot, file));
copyFileSync(join(root, "docs", "SBOM.cdx.json"), join(installRoot, "SBOM.cdx.json"));
const launcher = join(installRoot, "polarbear-memory");
writeFileSync(launcher, `#!/bin/sh\nset -eu\nINSTALL_ROOT=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"\nexec \"$INSTALL_ROOT/runtime/node\" \"$INSTALL_ROOT/dist/cli.js\" \"$@\"\n`, { mode: 0o755 });
symlinkSync("../lib/polarbear-memory/polarbear-memory", join(binRoot, "polarbear-memory"));
run(join(installRoot, "runtime", "node"), [join(installRoot, "dist", "cli.js"), "--version"]);

const suffix = unsigned ? "unsigned" : "signed-notarized";
const artifact = join(artifacts, `polarbear-memory-${pkg.version}-macos-${process.arch}-${suffix}.pkg`);
if (existsSync(artifact)) rmSync(artifact);
const pkgArgs = ["--root", payload, "--identifier", "com.smartscity.polarbear-memory", "--version", pkg.version, "--install-location", "/", artifact];
if (!unsigned) pkgArgs.splice(pkgArgs.length - 1, 0, "--sign", signingIdentity);
run("pkgbuild", pkgArgs);
if (!unsigned) {
  run("xcrun", ["notarytool", "submit", artifact, "--keychain-profile", notaryProfile, "--wait"]);
  run("xcrun", ["stapler", "staple", artifact]);
  run("pkgutil", ["--check-signature", artifact]);
  run("xcrun", ["stapler", "validate", artifact]);
}
const digest = createHash("sha256").update(readFileSync(artifact)).digest("hex");
writeFileSync(`${artifact}.sha256`, `${digest}  ${basename(artifact)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(`Created ${artifact}`);
rmSync(temporary, { recursive: true, force: true });
