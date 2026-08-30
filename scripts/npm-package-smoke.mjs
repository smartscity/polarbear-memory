import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "polarbear-memory-package-smoke-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const expectedVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (typeof expectedVersion !== "string") throw new Error("package.json version must be a string.");

function run(command, args, cwd, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnvironment },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

try {
  const packageDirectory = join(temporaryRoot, "package");
  const installDirectory = join(temporaryRoot, "install");
  const demoDirectory = join(temporaryRoot, "demo");
  const npmCache = join(temporaryRoot, "npm-cache");
  const dataDirectory = join(temporaryRoot, "data");
  const nestedNpmEnvironment = { npm_config_cache: npmCache, npm_config_dry_run: "false" };
  const memoryEnvironment = { POLARBEAR_MEMORY_DATA_DIR: dataDirectory };
  mkdirSync(packageDirectory);
  mkdirSync(installDirectory);

  const packed = run(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", packageDirectory], root, {
    ...nestedNpmEnvironment,
  });
  const manifests = JSON.parse(packed);
  const filename = manifests[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not return a tarball filename.");
  const tarball = join(packageDirectory, filename);

  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDirectory, tarball], installDirectory, {
    ...nestedNpmEnvironment,
  });
  const executable = process.platform === "win32"
    ? join(installDirectory, "node_modules", ".bin", "polarbear-memory.cmd")
    : join(installDirectory, "node_modules", ".bin", "polarbear-memory");
  const version = run(executable, ["--version"], installDirectory).trim();
  if (version !== expectedVersion) throw new Error(`installed CLI returned ${version}; package.json declares ${expectedVersion}.`);

  run("git", ["init", "--quiet", demoDirectory], temporaryRoot);
  const dryRun = run(executable, ["install", "--dry-run"], demoDirectory, memoryEnvironment);
  if (!dryRun.includes("Dry run only; no files were changed.")) throw new Error("installed CLI install --dry-run did not complete.");
  if (existsSync(join(demoDirectory, ".polarbear", "config.toml"))) throw new Error("install --dry-run initialized the project.");
  run(executable, ["install"], demoDirectory, memoryEnvironment);
  for (const relativePath of [
    join(".polarbear", "config.toml"), ".mcp.json", join(".claude", "settings.json"), join(".codex", "config.toml"),
  ]) {
    if (!existsSync(join(demoDirectory, relativePath))) throw new Error(`installed CLI did not create ${relativePath}.`);
  }
  const doctor = run(executable, ["doctor"], demoDirectory, memoryEnvironment);
  if (!/Claude MCP\s+OK/u.test(doctor) || !/Codex MCP\s+OK/u.test(doctor)) {
    throw new Error("installed CLI doctor did not confirm both Agent integrations.");
  }
  const savings = run(executable, ["savings"], demoDirectory, memoryEnvironment);
  if (!savings.includes("Estimated tokens saved")) throw new Error("installed CLI savings command did not complete.");
  const reset = run(executable, ["savings", "reset", "--confirm", "RESET"], demoDirectory, memoryEnvironment);
  if (!reset.includes("Token savings counters reset.")) throw new Error("installed CLI savings reset did not complete.");
  console.log(`npm tarball smoke test OK: installed CLI ${version}, unified Agent install and savings commands passed.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
