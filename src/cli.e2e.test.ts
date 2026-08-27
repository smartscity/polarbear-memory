import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const CLI_PROCESS_TIMEOUT_MS = 120_000;
const SQLITE_EXPERIMENTAL_WARNING = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n)?/gmu;

function assertNoUnexpectedStderr(stderr: string): void {
  assert.equal(stderr.replace(SQLITE_EXPERIMENTAL_WARNING, ""), "");
}

test("CLI stderr policy tolerates only the known Node 24 SQLite warning", () => {
  assertNoUnexpectedStderr(
    "(node:25778) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n" +
    "(Use `node --trace-warnings ...` to show where the warning was created)\n",
  );
  assert.throws(() => assertNoUnexpectedStderr("unexpected application error\n"));
});

function run(command: string, args: string[], cwd: string, dataDir?: string, input?: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: CLI_PROCESS_TIMEOUT_MS,
    ...(input === undefined ? {} : { input }),
    env: dataDir ? { ...process.env, POLARBEAR_MEMORY_DATA_DIR: dataDir } : process.env,
  });
  const failure = [
    `command failed: ${command} ${args.join(" ")}`,
    `status=${String(result.status)} signal=${String(result.signal)}`,
    result.error ? `spawn error: ${result.error.message}` : "",
    result.stderr,
  ].filter(Boolean).join("\n");
  assert.equal(result.status, 0, failure);
  return result;
}

test("CLI completes Memory, lifecycle, hook and real MCP stdio flows", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "polarbear-memory-cli-"));
  const repository = join(temporary, "repo");
  const dataDir = join(temporary, "data");
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const denyNetwork = fileURLToPath(new URL("./test/deny-network.js", import.meta.url));
  const fixture = resolve("fixtures/resume-basic/fixture.json");
  const offline = (args: string[]) => ["--import", denyNetwork, cli, ...args];
  try {
    run("git", ["init", "-q", repository], temporary);
    const dryRun = run(process.execPath, offline(["init", "--dry-run"]), repository, dataDir);
    assert.match(dryRun.stdout, /no files were changed/);

    run(process.execPath, offline(["init"]), repository, dataDir);
    const maintenancePreview = run(process.execPath, offline(["maintain", "--dry-run"]), repository, dataDir);
    assert.match(maintenancePreview.stdout, /"policyVersion": "mvp3-v1"/);
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
    const backupPath = /Backup created: (.+)/u.exec(backup.stdout)?.[1]?.trim();
    assert.ok(backupPath);
    assert.match(run(process.execPath, offline(["backup", "list"]), repository, dataDir).stdout, /integrity=ok/);
    assert.match(run(process.execPath, offline(["backup", "verify", backupPath]), repository, dataDir).stdout, /"integrity": "ok"/);

    const benchmark = run(process.execPath, offline(["benchmark", fixture]), repository, dataDir);
    assert.match(benchmark.stdout, /"passed": true/);
    const resumeSuite = run(process.execPath, offline(["benchmark", resolve("fixtures/resume-10/fixture.json")]), repository, dataDir);
    assert.match(resumeSuite.stdout, /"validPacks": 10/);
    assert.match(resumeSuite.stdout, /"medianFileReadReductionPercent": 40/);
    assert.match(resumeSuite.stdout, /"medianTokenReductionPercent": 4[0-9]/);
    const retentionSuite = run(process.execPath, offline(["benchmark", resolve("fixtures/retention-180d/fixture.json")]), repository, dataDir);
    assert.match(retentionSuite.stdout, /"kind": "retention-suite"/);
    assert.match(retentionSuite.stdout, /"canonicalAutoPurgeCount": 0/);

    const claudeDryRun = run(process.execPath, offline(["claude", "install", "--dry-run"]), repository, dataDir);
    assert.match(claudeDryRun.stdout, /no files were changed/);
    run(process.execPath, offline(["claude", "install"]), repository, dataDir);
    const hookStop = run(process.execPath, offline(["hook", "ingest", "--event", "Stop"]), repository, dataDir, JSON.stringify({
      hook_event_name: "Stop",
      session_id: "cli-e2e-session",
      cwd: repository,
      last_assistant_message: "Decision: Use the automatic hook decision path.",
    }));
    assert.equal(hookStop.stdout, "");
    assertNoUnexpectedStderr(hookStop.stderr);
    const hookEnd = run(process.execPath, offline(["hook", "ingest", "--event", "SessionEnd"]), repository, dataDir, JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "cli-e2e-session",
      cwd: repository,
      reason: "other",
    }));
    assert.equal(hookEnd.stdout, "");
    assertNoUnexpectedStderr(hookEnd.stderr);
    assert.match(run(process.execPath, offline(["search", "automatic decision"]), repository, dataDir).stdout, /automatic hook decision/);
    const doctor = run(process.execPath, offline(["doctor"]), repository, dataDir);
    assert.match(doctor.stdout, /Claude MCP\s+OK/);
    const diagnostics = run(process.execPath, offline(["doctor", "--export"]), repository, dataDir);
    assert.match(diagnostics.stdout, /contain no Memory content/);
    const diagnosticsPath = /Diagnostics\s+(.+\.json)/u.exec(diagnostics.stdout)?.[1]?.trim();
    assert.ok(diagnosticsPath && existsSync(diagnosticsPath));
    const diagnosticsBody = readFileSync(diagnosticsPath, "utf8");
    assert.doesNotMatch(diagnosticsBody, /Do not retry settlement|cli-e2e-session/u);
    assert.doesNotMatch(diagnosticsBody, new RegExp(repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

    const inheritedEnvironment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...offline(["mcp", "--stdio", "--project-root", repository])],
      cwd: repository,
      env: { ...inheritedEnvironment, POLARBEAR_MEMORY_DATA_DIR: dataDir },
      stderr: "pipe",
    });
    const stderr: Buffer[] = [];
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const client = new Client({ name: "stdio-e2e", version: "1.0.0" });
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 5);
      const contextOverStdio = await client.callTool({
        name: "memory_context",
        arguments: { task: "settlement retry", budget: 400 },
      });
      assert.equal(contextOverStdio.isError, undefined);
    } finally {
      await client.close();
    }
    assertNoUnexpectedStderr(Buffer.concat(stderr).toString("utf8"));

    run(process.execPath, offline(["claude", "restore"]), repository, dataDir);
    const restorePreview = run(process.execPath, offline(["backup", "restore", backupPath]), repository, dataDir);
    const backupName = backupPath.split("/").at(-1) as string;
    assert.match(restorePreview.stdout, new RegExp(`--confirm ${backupName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
    assert.match(run(process.execPath, offline(["backup", "restore", backupPath, "--confirm", backupName]), repository, dataDir).stdout, /Previous database preserved/);
    run(process.execPath, offline(["claude", "install"]), repository, dataDir);
    assert.match(run(process.execPath, offline(["uninstall", "--dry-run"]), repository, dataDir).stdout, /Dry run only/);
    assert.match(run(process.execPath, offline(["uninstall", "--keep-data"]), repository, dataDir).stdout, /Project data preserved/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
