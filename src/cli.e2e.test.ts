import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function run(command: string, args: string[], cwd: string, dataDir?: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    env: dataDir ? { ...process.env, POLARBEAR_MEMORY_DATA_DIR: dataDir } : process.env,
  });
  assert.equal(result.status, 0, `command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
  return result;
}

test("CLI completes init, record, search, context, backup and benchmark", () => {
  const temporary = mkdtempSync(join(tmpdir(), "polarbear-memory-cli-"));
  const repository = join(temporary, "repo");
  const dataDir = join(temporary, "data");
  const cli = resolve("dist/cli.js");
  const denyNetwork = resolve("dist/test/deny-network.js");
  const fixture = resolve("fixtures/resume-basic/fixture.json");
  const offline = (args: string[]) => ["--import", denyNetwork, cli, ...args];
  try {
    run("git", ["init", "-q", repository], temporary);
    const dryRun = run(process.execPath, offline(["init", "--dry-run"]), repository, dataDir);
    assert.match(dryRun.stdout, /no files were changed/);

    run(process.execPath, offline(["init"]), repository, dataDir);
    const recorded = run(process.execPath, [
      ...offline(["record"]), "--type", "PITFALL", "--summary", "Do not retry settlement in a transaction",
      "--file", "src/settlement.ts",
    ], repository, dataDir);
    assert.match(recorded.stdout, /Recorded PITFALL/);

    const searched = run(process.execPath, offline(["search", "settlement retry"]), repository, dataDir);
    assert.match(searched.stdout, /Do not retry settlement/);

    const context = run(process.execPath, offline(["context", "--task", "settlement retry", "--budget", "400"]), repository, dataDir);
    assert.match(context.stdout, /Polarbear Memory Context/);
    assert.match(context.stdout, /Do not retry settlement/);

    const backup = run(process.execPath, offline(["backup"]), repository, dataDir);
    assert.match(backup.stdout, /Backup created/);

    const benchmark = run(process.execPath, offline(["benchmark", fixture]), repository, dataDir);
    assert.match(benchmark.stdout, /"passed": true/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
