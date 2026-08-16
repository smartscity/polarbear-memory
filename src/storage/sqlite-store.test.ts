import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { compileContext } from "../application/context.js";
import { SqliteMemoryStore } from "./sqlite-store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore(): { store: SqliteMemoryStore; projectId: string } {
  const directory = mkdtempSync(join(tmpdir(), "polarbear-memory-test-"));
  temporaryDirectories.push(directory);
  const store = new SqliteMemoryStore(join(directory, "memory.db"));
  const projectId = "11111111-1111-4111-8111-111111111111";
  store.initializeProject({ id: projectId, name: "fixture" });
  return { store, projectId };
}

test("records, reads and searches a memory through FTS5", () => {
  const { store, projectId } = createStore();
  try {
    const inserted = store.record(projectId, {
      type: "PITFALL",
      summary: "Do not retry settlement inside a transaction",
      content: "Remote calls while holding row locks caused timeouts.",
      files: ["src/settlement.ts"],
      commitSha: "abc123",
    });
    assert.deepEqual(store.get(projectId, inserted.id)?.files, ["src/settlement.ts"]);
    assert.equal(store.search(projectId, "settlement retry", 10)[0]?.memory.id, inserted.id);
    assert.deepEqual(store.status(projectId), { total: 1, active: 1 });

    const duplicate = store.record(projectId, {
      type: "PITFALL",
      summary: "Do not retry settlement inside a transaction",
      content: "Remote calls while holding row locks caused timeouts.",
      files: ["test/settlement.test.ts"],
    });
    assert.equal(duplicate.id, inserted.id);
    assert.deepEqual(duplicate.files, ["src/settlement.ts", "test/settlement.test.ts"]);
    assert.deepEqual(store.status(projectId), { total: 1, active: 1 });
  } finally {
    store.close();
  }
});

test("compiles relevant memory without exceeding the token budget", () => {
  const { store, projectId } = createStore();
  try {
    store.record(projectId, {
      type: "TASK_STATE",
      summary: "Issue 42 recovery implementation is complete",
      content: "The next step is adding recovery tests.",
    });
    store.record(projectId, {
      type: "TODO",
      summary: "Change dashboard colors",
      content: "Unrelated UI work.",
    });
    const context = compileContext(store, projectId, "continue issue 42 recovery", 200);
    assert.match(context.markdown, /Issue 42 recovery implementation is complete/);
    assert.doesNotMatch(context.markdown, /dashboard colors/);
    assert.ok(context.estimatedTokens <= 200);
  } finally {
    store.close();
  }
});

test("schema initialization, backup and FTS rebuild are reliable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "polarbear-memory-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "memory.db");
  const projectId = "22222222-2222-4222-8222-222222222222";
  const first = new SqliteMemoryStore(path);
  first.initializeProject({ id: projectId, name: "fixture" });
  first.record(projectId, { type: "DECISION", summary: "Use SQLite FTS5" });
  const backupPath = join(directory, "backup.db");
  assert.ok(await first.backup(backupPath) > 0);
  first.close();

  const second = new SqliteMemoryStore(path);
  try {
    second.initializeProject({ id: projectId, name: "fixture" });
    second.rebuildSearchIndex();
    assert.equal(second.search(projectId, "SQLite", 10).length, 1);
  } finally {
    second.close();
  }

  const restored = new SqliteMemoryStore(backupPath);
  try {
    assert.equal(restored.search(projectId, "SQLite", 10).length, 1);
  } finally {
    restored.close();
  }
});
