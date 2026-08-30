import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installClaudeIntegration, readClaudeLaunchSpec } from "../adapters/claude-code/integration.js";
import { installCodexIntegration, readCodexLaunchSpec } from "../adapters/codex/integration.js";
import { SqliteMemoryStore } from "../storage/sqlite-store.js";
import { minimalAgentEnvironment, probeMcpLaunch, resolveAgentRuntime, type AgentLaunchProbe } from "./agent-launch.js";
import type { ProjectBinding } from "./project.js";
import { writeProjectConfig } from "./project.js";

const CODEX_HANDSHAKES = 40;
const CLAUDE_HANDSHAKES = 5;

function assertNoLeaks(results: AgentLaunchProbe[]): void {
  const pids = results.map((result) => result.pid).filter((pid): pid is number => pid !== undefined);
  assert.equal(pids.length, results.length);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), `MCP probe leaked child process ${pid}`);
}

test("Codex MCP completes 40 consecutive handshakes without timeouts or child leaks", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "polarbear-mcp-probe-stress-"));
  const root = join(temporary, "repo with spaces");
  const dataRoot = join(temporary, "data with spaces");
  const id = randomUUID();
  const project: ProjectBinding = {
    id,
    name: "mcp-probe-stress",
    root,
    configPath: join(root, ".polarbear", "config.toml"),
    dataDir: join(dataRoot, "projects", id),
    databasePath: join(dataRoot, "projects", id, "memory.db"),
  };
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  writeProjectConfig(project);
  const store = new SqliteMemoryStore(project.databasePath);
  try {
    store.initializeProject(project);
  } finally {
    store.close();
  }

  try {
    const runtime = resolveAgentRuntime();
    installCodexIntegration(project, { dryRun: false, runtime });
    installClaudeIntegration(project, { dryRun: false, runtime });
    const codexSpec = readCodexLaunchSpec(project);
    const claudeSpec = readClaudeLaunchSpec(project);
    assert.ok(codexSpec);
    assert.ok(claudeSpec);
    const env = minimalAgentEnvironment({ ...process.env, POLARBEAR_MEMORY_DATA_DIR: dataRoot });
    const codexResults: AgentLaunchProbe[] = [];
    for (let attempt = 0; attempt < CODEX_HANDSHAKES; attempt += 1) {
      codexResults.push(await probeMcpLaunch(codexSpec, { cwd: root, env }));
    }
    assert.deepEqual(codexResults.filter((result) => !result.ok).map(({ kind, detail }) => ({ kind, detail })), []);
    assert.equal(codexResults.filter((result) => result.ok).length, CODEX_HANDSHAKES);
    assert.equal(codexResults.filter((result) => result.kind === "INITIALIZE_TIMEOUT").length, 0);
    assertNoLeaks(codexResults);

    const claudeResults: AgentLaunchProbe[] = [];
    for (let attempt = 0; attempt < CLAUDE_HANDSHAKES; attempt += 1) {
      claudeResults.push(await probeMcpLaunch(claudeSpec, { cwd: root, env }));
    }
    assert.deepEqual(claudeResults.filter((result) => !result.ok).map(({ kind, detail }) => ({ kind, detail })), []);
    assert.equal(claudeResults.filter((result) => result.ok).length, CLAUDE_HANDSHAKES);
    assertNoLeaks(claudeResults);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
