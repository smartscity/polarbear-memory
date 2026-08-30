import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ProjectBinding } from "../platform/project.js";
import { SqliteMemoryStore } from "../storage/sqlite-store.js";
import { inspectBackup, listBackups, restoreBackup } from "./recovery.js";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("validates and restores a backup while preserving a rollback database", async () => {
  const root = mkdtempSync(join(tmpdir(), "polarbear-recovery-"));
  temporaryDirectories.push(root);
  const project: ProjectBinding = {
    id: "55555555-5555-4555-8555-555555555555",
    name: "recovery",
    root,
    configPath: join(root, ".polarbear", "config.toml"),
    dataDir: join(root, "data with spaces"),
    databasePath: join(root, "data with spaces", "memory.db"),
  };
  mkdirSync(join(project.dataDir, "backups"), { recursive: true });
  const store = new SqliteMemoryStore(project.databasePath);
  store.initializeProject(project);
  store.record(project.id, { type: "DECISION", summary: "Before backup" });
  const backupPath = join(project.dataDir, "backups", "known-good.db");
  await store.backup(backupPath);
  store.record(project.id, { type: "TODO", summary: "After backup" });
  assert.throws(() => restoreBackup(project, "known-good.db"), /active clients/u);
  store.close();

  assert.equal(inspectBackup(project, "known-good.db").integrity, "ok");
  assert.equal(inspectBackup(project, backupPath).integrity, "ok");
  assert.equal(listBackups(project).length, 1);
  const restored = restoreBackup(project, "known-good.db");
  assert.ok(restored.rollbackPath && existsSync(restored.rollbackPath));
  const next = new SqliteMemoryStore(project.databasePath);
  try {
    assert.equal(next.search(project.id, "Before backup", 10).length, 1);
    assert.equal(next.search(project.id, "After", 10).length, 0);
  } finally { next.close(); }
  assert.equal(readFileSync(project.databasePath).subarray(0, 16).toString("utf8"), "SQLite format 3\u0000");
});

test("rejects backups outside the project backup root", () => {
  const root = mkdtempSync(join(tmpdir(), "polarbear-recovery-boundary-"));
  temporaryDirectories.push(root);
  const project = { id: "x", name: "x", root, configPath: join(root, "config"), dataDir: join(root, "data"), databasePath: join(root, "data", "memory.db") };
  assert.throws(() => inspectBackup(project, join(root, "outside.db")), /inside this project's backup directory/);
});
