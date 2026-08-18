import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { discoverGitContext } from "../platform/git.js";
import { planProject, writeProjectConfig } from "../platform/project.js";
import { SqliteMemoryStore } from "../storage/sqlite-store.js";
import { ADMIN_API_VERSION, startAdminApi, type AdminServiceHandle } from "./server.js";

const temporaryDirectories: string[] = [];
const handles: AdminServiceHandle[] = [];
const originalDataRoot = process.env.POLARBEAR_MEMORY_DATA_DIR;

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  if (originalDataRoot === undefined) delete process.env.POLARBEAR_MEMORY_DATA_DIR;
  else process.env.POLARBEAR_MEMORY_DATA_DIR = originalDataRoot;
});

function repository(): { root: string; dataRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "polarbear-admin-repo-"));
  const dataRoot = mkdtempSync(join(tmpdir(), "polarbear-admin-data-"));
  temporaryDirectories.push(root, dataRoot);
  process.env.POLARBEAR_MEMORY_DATA_DIR = dataRoot;
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  const project = planProject(discoverGitContext(root));
  writeProjectConfig(project);
  const store = new SqliteMemoryStore(project.databasePath);
  try {
    store.initializeProject(project);
    store.record(project.id, {
      type: "PITFALL",
      summary: "Never render remote Memory resources",
      content: "![tracking](https://attacker.invalid/pixel)\n@startuml\n!include https://attacker.invalid/a\n@enduml",
    });
  } finally {
    store.close();
  }
  return { root, dataRoot };
}

async function request(handle: AdminServiceHandle, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolveRequest, reject) => {
    const client = createConnection(handle.paths.socket);
    let output = "";
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => { output += chunk; });
    client.on("end", () => {
      try { resolveRequest(JSON.parse(output) as Record<string, unknown>); } catch (error) { reject(error); }
    });
    client.on("error", reject);
    client.on("connect", () => client.write(`${JSON.stringify(body)}\n`));
  });
}

test("serves authenticated versioned Admin API only over a user socket", async () => {
  const fixture = repository();
  const handle = await startAdminApi(fixture.dataRoot);
  handles.push(handle);
  assert.equal(typeof handle.paths.socket, "string");
  assert.equal(statSync(handle.paths.directory).mode & 0o077, 0);
  assert.equal(statSync(handle.paths.socket).mode & 0o077, 0);
  assert.equal(statSync(handle.paths.token).mode & 0o077, 0);

  const denied = await request(handle, { id: "1", apiVersion: ADMIN_API_VERSION, token: "wrong", method: "system.hello", params: {} });
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.error, { code: "UNAUTHORIZED", message: "The local service token is invalid." });

  const token = readFileSync(handle.paths.token, "utf8").trim();
  const hello = await request(handle, { id: "2", apiVersion: ADMIN_API_VERSION, token, method: "system.hello", params: {} });
  assert.equal(hello.ok, true);
  assert.equal((hello.result as { transport: string }).transport, "local-user-socket");

  const status = await request(handle, {
    id: "3", apiVersion: ADMIN_API_VERSION, token, method: "projects.status", params: { projectRoot: fixture.root },
  });
  assert.equal(status.ok, true);
  assert.equal((status.result as { counts: { total: number } }).counts.total, 1);

  const shutdown = await request(handle, { id: "3-stop", apiVersion: ADMIN_API_VERSION, token, method: "system.shutdown", params: {} });
  assert.deepEqual(shutdown.result, { stopping: true });
  await handle.closed;
  assert.equal(existsSync(handle.paths.socket), false);
});

test("returns malicious Memory as inert data and explains exact Context selection", async () => {
  const fixture = repository();
  const handle = await startAdminApi(fixture.dataRoot);
  handles.push(handle);
  const token = readFileSync(handle.paths.token, "utf8").trim();
  const listed = await request(handle, {
    id: "4", apiVersion: ADMIN_API_VERSION, token, method: "memories.list",
    params: { projectRoot: fixture.root, query: "remote resources" },
  });
  const item = (listed.result as { items: Array<{ id: string; content: string }> }).items[0];
  assert.ok(item);
  assert.match(item.content, /https:\/\/attacker\.invalid/);

  const explained = await request(handle, {
    id: "5", apiVersion: ADMIN_API_VERSION, token, method: "contexts.explain",
    params: { projectRoot: fixture.root, task: "remote resources", budget: 1000 },
  });
  assert.deepEqual((explained.result as { selectedMemoryIds: string[] }).selectedMemoryIds, [item.id]);
});

test("rejects incompatible API major versions without leaking local paths", async () => {
  const fixture = repository();
  const handle = await startAdminApi(fixture.dataRoot);
  handles.push(handle);
  const token = readFileSync(handle.paths.token, "utf8").trim();
  const response = await request(handle, { id: "6", apiVersion: "2.0", token, method: "projects.status", params: { projectRoot: fixture.root } });
  assert.equal(response.ok, false);
  assert.deepEqual(response.error, { code: "INCOMPATIBLE_API", message: "Memory Admin API 1.1 is required." });
  assert.doesNotMatch(JSON.stringify(response), new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("promotes only after an unchanged explicit preview", async () => {
  const fixture = repository();
  const handle = await startAdminApi(fixture.dataRoot);
  handles.push(handle);
  const token = readFileSync(handle.paths.token, "utf8").trim();
  const listed = await request(handle, {
    id: "7", apiVersion: ADMIN_API_VERSION, token, method: "memories.list", params: { projectRoot: fixture.root },
  });
  const memoryId = (listed.result as { items: Array<{ id: string }> }).items[0]?.id;
  assert.ok(memoryId);
  const preview = await request(handle, {
    id: "8", apiVersion: ADMIN_API_VERSION, token, method: "knowledge.promote_preview", params: { projectRoot: fixture.root, memoryId },
  });
  const plan = preview.result as { path: string; content: string; sha256: string };
  assert.equal(existsSync(join(fixture.root, plan.path)), false);
  assert.match(plan.content, /https:\/\/attacker\.invalid/);
  const changed = await request(handle, {
    id: "9", apiVersion: ADMIN_API_VERSION, token, method: "knowledge.promote", params: { projectRoot: fixture.root, memoryId, expectedSha256: "0".repeat(64) },
  });
  assert.equal((changed.error as { code: string }).code, "PROMOTION_CHANGED");
  const written = await request(handle, {
    id: "10", apiVersion: ADMIN_API_VERSION, token, method: "knowledge.promote", params: { projectRoot: fixture.root, memoryId, expectedSha256: plan.sha256 },
  });
  assert.equal(written.ok, true);
  assert.equal(readFileSync(join(fixture.root, plan.path), "utf8"), plan.content);
});

test("exposes revision history, explainable maintenance, diagnostics and safe backup operations", async () => {
  const fixture = repository();
  const handle = await startAdminApi(fixture.dataRoot);
  handles.push(handle);
  const token = readFileSync(handle.paths.token, "utf8").trim();
  const listed = await request(handle, {
    id: "admin-1", apiVersion: ADMIN_API_VERSION, token, method: "memories.list", params: { projectRoot: fixture.root },
  });
  const memoryId = (listed.result as { items: Array<{ id: string }> }).items[0]?.id;
  assert.ok(memoryId);

  const history = await request(handle, {
    id: "admin-2", apiVersion: ADMIN_API_VERSION, token, method: "memories.history",
    params: { projectRoot: fixture.root, memoryId },
  });
  assert.equal((history.result as { items: unknown[] }).items.length, 1);

  const diagnostics = await request(handle, {
    id: "admin-3", apiVersion: ADMIN_API_VERSION, token, method: "projects.diagnostics", params: { projectRoot: fixture.root },
  });
  assert.equal((diagnostics.result as { networkPolicy: string }).networkPolicy, "disabled");
  assert.doesNotMatch(JSON.stringify(diagnostics.result), /memory\.db|projectRoot/u);
  const configured = await request(handle, {
    id: "admin-config-1", apiVersion: ADMIN_API_VERSION, token, method: "projects.config_update",
    params: { projectRoot: fixture.root, captureMode: "manual", rawEventRetentionDays: 3 },
  });
  assert.deepEqual(configured.result, { captureMode: "manual", rawEventRetentionDays: 3, defaultContextBudget: 1000 });
  const readConfig = await request(handle, {
    id: "admin-config-2", apiVersion: ADMIN_API_VERSION, token, method: "projects.config", params: { projectRoot: fixture.root },
  });
  assert.deepEqual(readConfig.result, configured.result);

  const preview = await request(handle, {
    id: "admin-4", apiVersion: ADMIN_API_VERSION, token, method: "maintenance.preview", params: { projectRoot: fixture.root },
  });
  assert.equal((preview.result as { dryRun: boolean }).dryRun, true);
  const maintained = await request(handle, {
    id: "admin-5", apiVersion: ADMIN_API_VERSION, token, method: "maintenance.run", params: { projectRoot: fixture.root },
  });
  assert.equal((maintained.result as { dryRun: boolean }).dryRun, false);

  const created = await request(handle, {
    id: "admin-6", apiVersion: ADMIN_API_VERSION, token, method: "backups.create", params: { projectRoot: fixture.root },
  });
  const backup = created.result as { fileName: string; integrity: string; sha256: string };
  assert.equal(backup.integrity, "ok");
  assert.match(backup.sha256, /^[a-f0-9]{64}$/u);
  const backups = await request(handle, {
    id: "admin-7", apiVersion: ADMIN_API_VERSION, token, method: "backups.list", params: { projectRoot: fixture.root },
  });
  assert.equal((backups.result as { items: Array<{ fileName: string }> }).items[0]?.fileName, backup.fileName);
  const verified = await request(handle, {
    id: "admin-8", apiVersion: ADMIN_API_VERSION, token, method: "backups.verify",
    params: { projectRoot: fixture.root, fileName: backup.fileName },
  });
  assert.equal((verified.result as { sha256: string }).sha256, backup.sha256);
  const restorePreview = await request(handle, {
    id: "admin-9", apiVersion: ADMIN_API_VERSION, token, method: "backups.restore_preview",
    params: { projectRoot: fixture.root, fileName: backup.fileName },
  });
  const confirmation = (restorePreview.result as { confirmation: string }).confirmation;
  const deniedRestore = await request(handle, {
    id: "admin-10", apiVersion: ADMIN_API_VERSION, token, method: "backups.restore",
    params: { projectRoot: fixture.root, fileName: backup.fileName, confirmation: "RESTORE wrong.db" },
  });
  assert.equal((deniedRestore.error as { code: string }).code, "CONFIRMATION_REQUIRED");
  const restored = await request(handle, {
    id: "admin-11", apiVersion: ADMIN_API_VERSION, token, method: "backups.restore",
    params: { projectRoot: fixture.root, fileName: backup.fileName, confirmation },
  });
  assert.equal(restored.ok, true);
  assert.ok((restored.result as { rollbackFileName: string }).rollbackFileName.startsWith("pre-restore-"));

  const updated = await request(handle, {
    id: "admin-12", apiVersion: ADMIN_API_VERSION, token, method: "memories.update",
    params: {
      projectRoot: fixture.root,
      memoryId,
      summary: "Never render remote Memory resources in the Desktop",
      content: "Treat all Memory content as inert text.",
      reason: "Clarify the rendering boundary",
    },
  });
  assert.equal((updated.result as { verificationState: string }).verificationState, "UNVERIFIED");
  const updatedHistory = await request(handle, {
    id: "admin-13", apiVersion: ADMIN_API_VERSION, token, method: "memories.history",
    params: { projectRoot: fixture.root, memoryId },
  });
  assert.equal((updatedHistory.result as { items: unknown[] }).items.length, 2);

  const purgePreview = await request(handle, {
    id: "admin-14", apiVersion: ADMIN_API_VERSION, token, method: "memories.purge_preview",
    params: { projectRoot: fixture.root, memoryId },
  });
  const purgeConfirmation = (purgePreview.result as { confirmation: string }).confirmation;
  const deniedPurge = await request(handle, {
    id: "admin-15", apiVersion: ADMIN_API_VERSION, token, method: "memories.purge",
    params: { projectRoot: fixture.root, memoryId, confirmation: "PURGE wrong", reason: "test" },
  });
  assert.equal((deniedPurge.error as { code: string }).code, "CONFIRMATION_REQUIRED");
  const purged = await request(handle, {
    id: "admin-16", apiVersion: ADMIN_API_VERSION, token, method: "memories.purge",
    params: { projectRoot: fixture.root, memoryId, confirmation: purgeConfirmation, reason: "Explicit test purge" },
  });
  assert.match((purged.result as { purgedMemoryIdHash: string }).purgedMemoryIdHash, /^[a-f0-9]{64}$/u);
  const missing = await request(handle, {
    id: "admin-17", apiVersion: ADMIN_API_VERSION, token, method: "memories.get",
    params: { projectRoot: fixture.root, memoryId },
  });
  assert.equal((missing.error as { code: string }).code, "NOT_FOUND");
});

test("handles concurrent local reads and keeps hello p95 below 200 ms", async () => {
  const fixture = repository();
  const handle = await startAdminApi(fixture.dataRoot);
  handles.push(handle);
  const token = readFileSync(handle.paths.token, "utf8").trim();
  const durations: number[] = [];
  const calls = Array.from({ length: 25 }, async (_, index) => {
    const started = performance.now();
    const response = await request(handle, {
      id: `perf-${index}`, apiVersion: ADMIN_API_VERSION, token, method: "system.hello", params: {},
    });
    durations.push(performance.now() - started);
    assert.equal(response.ok, true);
  });
  await Promise.all(calls);
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  assert.ok(p95 !== undefined && p95 < 200, `hello p95 was ${p95?.toFixed(1)} ms`);
});
