import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { discoverGitContext } from "../../platform/git.js";
import { planProject, writeProjectConfig } from "../../platform/project.js";
import { SqliteMemoryStore } from "../../storage/sqlite-store.js";

test("owned App Server process injects Context, preserves responses, and distills completion", () => {
  const temporary = mkdtempSync(join(tmpdir(), "polarbear-codex-app-server-"));
  const priorDataRoot = process.env.POLARBEAR_MEMORY_DATA_DIR;
  try {
    const root = join(temporary, "repo");
    assert.equal(spawnSync("git", ["init", "-q", root], { shell: false }).status, 0);
    const dataRoot = join(temporary, "data");
    process.env.POLARBEAR_MEMORY_DATA_DIR = dataRoot;
    const project = planProject(discoverGitContext(root));
    writeProjectConfig(project);
    const store = new SqliteMemoryStore(project.databasePath);
    store.initializeProject(project);
    const task = store.contextOs().createTask(project.id, {
      title: "Managed Codex gateway", objective: "Continue the owned App Server integration.", phase: "IMPLEMENTATION",
    });
    store.record(project.id, {
      type: "CONSTRAINT", summary: "Keep approvals under client control", scopeKind: "TASK", scopeRef: task.id,
    });
    store.close();

    const fakeCodex = join(temporary, "fake-codex.mjs");
    writeFileSync(fakeCodex, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake-codex" } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { seenInput: message.params.input } });
    send({ id: 40, method: "item/commandExecution/requestApproval", params: { threadId: message.params.threadId, turnId: "turn-1", itemId: "tool-approval", availableDecisions: ["accept", "decline"] } });
    send({ method: "thread/started", params: { thread: { id: message.params.threadId } } });
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: "turn-1", item: { id: "message-1", type: "agentMessage", text: "Decision: Keep the managed gateway provider-neutral." } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "turn-1", status: "completed" } } });
    send({ method: "thread/closed", params: { threadId: message.params.threadId } });
  }
  if (message.id === 90 && message.result) send({ id: 99, result: { approvalResponse: message.result } });
}
`, { mode: 0o700 });
    chmodSync(fakeCodex, 0o700);

    const input = [
      { id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "1" } } },
      { method: "initialized" },
      { id: 2, method: "turn/start", params: { threadId: "thread-1", input: [{ type: "text", text: "Continue private-prompt-6651." }] } },
      { id: 90, result: { decision: "accept" } },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";
    const result = spawnSync(process.execPath, [
      join(process.cwd(), "dist-test", "cli.js"), "codex", "app-server", "run",
      "--codex-command", fakeCodex, "--project-root", root, "--task", task.id,
    ], {
      cwd: root,
      env: { ...process.env, POLARBEAR_MEMORY_DATA_DIR: dataRoot },
      input,
      encoding: "utf8",
      shell: false,
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const messages = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
    const turnResponse = messages.find(({ id }) => id === 2) as { result: { seenInput: Array<Record<string, unknown>> } } | undefined;
    assert.equal(turnResponse?.result.seenInput.length, 2);
    assert.match(String(turnResponse?.result.seenInput[1]?.text), /Keep approvals under client control/u);
    const approval = messages.find(({ id }) => id === 99) as { result: { approvalResponse: { decision: string } } } | undefined;
    assert.equal(approval?.result.approvalResponse.decision, "accept");
    const approvalRequest = messages.find(({ id }) => id === 40) as { method?: string; params?: { availableDecisions?: string[] } } | undefined;
    assert.equal(approvalRequest?.method, "item/commandExecution/requestApproval");
    assert.deepEqual(approvalRequest?.params?.availableDecisions, ["accept", "decline"]);

    const verified = new SqliteMemoryStore(project.databasePath);
    try {
      assert.equal(verified.search(project.id, "managed gateway provider-neutral", 10)
        .some(({ memory }) => memory.summary === "Keep the managed gateway provider-neutral."), true);
    } finally {
      verified.close();
    }
  } finally {
    if (priorDataRoot === undefined) delete process.env.POLARBEAR_MEMORY_DATA_DIR;
    else process.env.POLARBEAR_MEMORY_DATA_DIR = priorDataRoot;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("owned App Server process fails open to a bounded redacted spool and replays on restart", () => {
  const temporary = mkdtempSync(join(tmpdir(), "polarbear-codex-spool-"));
  const priorDataRoot = process.env.POLARBEAR_MEMORY_DATA_DIR;
  try {
    const root = join(temporary, "repo");
    assert.equal(spawnSync("git", ["init", "-q", root], { shell: false }).status, 0);
    const dataRoot = join(temporary, "data");
    process.env.POLARBEAR_MEMORY_DATA_DIR = dataRoot;
    const project = planProject(discoverGitContext(root));
    writeProjectConfig(project);
    mkdirSync(project.databasePath);
    const fakeCodex = join(temporary, "fake-codex.mjs");
    writeFileSync(fakeCodex, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake-codex" } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: {} });
    send({ method: "thread/started", params: { thread: { id: message.params.threadId } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "turn-spool", status: "failed", error: { message: "fixture failure" } } } });
    send({ method: "thread/closed", params: { threadId: message.params.threadId } });
  }
}
`, { mode: 0o700 });
    chmodSync(fakeCodex, 0o700);
    const cli = join(process.cwd(), "dist-test", "cli.js");
    const run = (input: string) => spawnSync(process.execPath, [
      cli, "codex", "app-server", "run", "--codex-command", fakeCodex, "--project-root", root,
    ], {
      cwd: root, env: { ...process.env, POLARBEAR_MEMORY_DATA_DIR: dataRoot }, input,
      encoding: "utf8", shell: false, timeout: 20_000,
    });
    const failedStorage = run([
      { id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "1" } } },
      { method: "initialized" },
      { id: 2, method: "turn/start", params: { threadId: "thread-spool", input: [{ type: "text", text: "Do not persist raw-marker-8519." }] } },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n");
    assert.equal(failedStorage.status, 0, failedStorage.stderr);
    const spool = join(project.dataDir, "spool", "codex-app-server");
    const queued = readdirSync(spool).filter((name) => name.endsWith(".json"));
    assert.ok(queued.length >= 3 && queued.length <= 512);
    assert.doesNotMatch(queued.map((name) => readFileSync(join(spool, name), "utf8")).join("\n"), /raw-marker-8519/u);

    rmSync(project.databasePath, { recursive: true, force: true });
    const replayed = run(`${JSON.stringify({ id: 3, method: "initialize", params: { clientInfo: { name: "test", version: "1" } } })}\n`);
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.equal(readdirSync(spool).filter((name) => name.endsWith(".json")).length, 0);
    const verified = new SqliteMemoryStore(project.databasePath);
    try {
      const metrics = verified.contextOs().lifecycleMetrics(project.id);
      assert.equal(metrics.eventsSpooled, queued.length);
      assert.equal(metrics.eventsReplayed, queued.length);
    } finally {
      verified.close();
    }
  } finally {
    if (priorDataRoot === undefined) delete process.env.POLARBEAR_MEMORY_DATA_DIR;
    else process.env.POLARBEAR_MEMORY_DATA_DIR = priorDataRoot;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("owned App Server process rejects oversized JSONL frames", () => {
  const temporary = mkdtempSync(join(tmpdir(), "polarbear-codex-frame-limit-"));
  const priorDataRoot = process.env.POLARBEAR_MEMORY_DATA_DIR;
  try {
    const root = join(temporary, "repo");
    assert.equal(spawnSync("git", ["init", "-q", root], { shell: false }).status, 0);
    const dataRoot = join(temporary, "data");
    process.env.POLARBEAR_MEMORY_DATA_DIR = dataRoot;
    const project = planProject(discoverGitContext(root));
    writeProjectConfig(project);
    const fakeCodex = join(temporary, "fake-codex.mjs");
    writeFileSync(fakeCodex, "#!/usr/bin/env node\nprocess.stdin.resume();\n", { mode: 0o700 });
    chmodSync(fakeCodex, 0o700);
    const result = spawnSync(process.execPath, [
      join(process.cwd(), "dist-test", "cli.js"), "codex", "app-server", "run",
      "--codex-command", fakeCodex, "--project-root", root,
    ], {
      cwd: root,
      env: { ...process.env, POLARBEAR_MEMORY_DATA_DIR: dataRoot },
      input: "x".repeat(1024 * 1024 + 1),
      encoding: "utf8",
      shell: false,
      timeout: 20_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JSONL frame exceeds the 1 MiB limit/u);
  } finally {
    if (priorDataRoot === undefined) delete process.env.POLARBEAR_MEMORY_DATA_DIR;
    else process.env.POLARBEAR_MEMORY_DATA_DIR = priorDataRoot;
    rmSync(temporary, { recursive: true, force: true });
  }
});
