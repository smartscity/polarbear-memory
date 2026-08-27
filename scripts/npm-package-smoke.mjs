import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
  const nestedNpmEnvironment = { npm_config_cache: npmCache, npm_config_dry_run: "false" };
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
  const dryRun = run(executable, ["init", "--dry-run"], demoDirectory);
  if (!dryRun.includes("Dry run only; no files were changed.")) throw new Error("installed CLI init --dry-run did not complete.");
  run(executable, ["init"], demoDirectory);
  const savings = run(executable, ["savings"], demoDirectory);
  if (!savings.includes("Estimated tokens saved")) throw new Error("installed CLI savings command did not complete.");
  const reset = run(executable, ["savings", "reset", "--confirm", "RESET"], demoDirectory);
  if (!reset.includes("Token savings counters reset.")) throw new Error("installed CLI savings reset did not complete.");
  console.log(`npm tarball smoke test OK: installed CLI ${version}, init and savings commands passed.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
