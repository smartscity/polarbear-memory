import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
    assert.deepEqual(store.status(projectId), { total: 1, active: 1, high_risk: 0, completed: 0 });

    const duplicate = store.record(projectId, {
      type: "PITFALL",
      summary: "Do not retry settlement inside a transaction",
      content: "Remote calls while holding row locks caused timeouts.",
      files: ["test/settlement.test.ts"],
    });
    assert.equal(duplicate.id, inserted.id);
    assert.deepEqual(duplicate.files, ["src/settlement.ts", "test/settlement.test.ts"]);
    assert.deepEqual(store.status(projectId), { total: 1, active: 1, high_risk: 0, completed: 0 });
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

test("records and resets estimated Context compiler token savings", () => {
  const { store, projectId } = createStore();
  try {
    for (let index = 0; index < 8; index += 1) {
      store.record(projectId, {
        type: "PITFALL",
        summary: `Settlement retry rule ${index}`,
        content: `Settlement retry evidence ${index}: ${"avoid duplicate transaction work ".repeat(8)}`,
      });
    }
    const context = compileContext(store, projectId, "settlement retry", 200);
    const savings = store.tokenSavings(projectId);
    assert.equal(savings.contextPackCount, 1);
    assert.equal(savings.candidateCount, 8);
    assert.equal(savings.selectedCount, context.selected);
    assert.equal(savings.contextTokens, context.estimatedTokens);
    assert.ok(savings.baselineTokens > savings.contextTokens);
    assert.equal(savings.estimatedSavedTokens, savings.baselineTokens - savings.contextTokens);

    const reset = store.resetTokenSavings(projectId, "2026-08-27T00:00:00.000Z");
    assert.equal(reset.contextPackCount, 0);
    assert.equal(reset.estimatedSavedTokens, 0);
    assert.equal(reset.measurementStartedAt, "2026-08-27T00:00:00.000Z");
    assert.equal(reset.resetCount, 1);
    assert.equal(store.status(projectId).total, 8);
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

test("migrates an MVP-0 database before accepting MCP and hook sources", () => {
  const directory = mkdtempSync(join(tmpdir(), "polarbear-memory-legacy-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "memory.db");
  const projectId = "33333333-3333-4333-8333-333333333333";
  const now = "2026-01-01T00:00:00.000Z";
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, schema_version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE memories (
      row_id INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('DECISION','PITFALL','TASK_STATE','TODO')),
      summary TEXT NOT NULL CHECK (length(summary) > 0), content TEXT NOT NULL CHECK (length(content) > 0),
      lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle_status IN ('ACTIVE','ARCHIVED','SUPERSEDED','REJECTED')),
      verification_state TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_state IN ('UNVERIFIED','VERIFIED','DISPUTED')),
      confidence_milli INTEGER NOT NULL CHECK (confidence_milli BETWEEN 0 AND 1000),
      importance_milli INTEGER NOT NULL CHECK (importance_milli BETWEEN 0 AND 1000),
      source_type TEXT NOT NULL CHECK (source_type IN ('CLI','FIXTURE')),
      commit_sha TEXT, branch_name TEXT, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE memory_revisions (
      id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      revision_no INTEGER NOT NULL, content TEXT NOT NULL, summary TEXT NOT NULL,
      reason TEXT NOT NULL, actor_kind TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(memory_id, revision_no)
    ) STRICT;
    CREATE TABLE memory_anchors (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      repo_relative_path TEXT NOT NULL, content_digest TEXT, captured_commit TEXT,
      PRIMARY KEY(memory_id, repo_relative_path)
    ) STRICT;
    CREATE TABLE memory_relations (
      source_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      target_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(source_memory_id, target_memory_id, relation_type)
    ) STRICT;
  `);
  legacy.prepare("INSERT INTO projects VALUES (?, 'legacy', ?, ?, 1)").run(projectId, now, now);
  const summary = "Preserve this legacy decision";
  const hash = createHash("sha256").update(`DECISION\0${summary}\0${summary}`).digest("hex");
  legacy.prepare(`
    INSERT INTO memories(
      id, project_id, type, summary, content, confidence_milli, importance_milli,
      source_type, content_hash, created_at, updated_at
    ) VALUES ('legacy-memory', ?, 'DECISION', ?, ?, 700, 500, 'CLI', ?, ?, ?)
  `).run(projectId, summary, summary, hash, now, now);
  const targetSummary = "Older decision retained for relation migration";
  const targetHash = createHash("sha256").update(`DECISION\0${targetSummary}\0${targetSummary}`).digest("hex");
  legacy.prepare(`
    INSERT INTO memories(
      id, project_id, type, summary, content, confidence_milli, importance_milli,
      source_type, content_hash, created_at, updated_at
    ) VALUES ('legacy-target', ?, 'DECISION', ?, ?, 700, 500, 'CLI', ?, ?, ?)
  `).run(projectId, targetSummary, targetSummary, targetHash, now, now);
  legacy.prepare("INSERT INTO memory_revisions VALUES ('legacy-revision', 'legacy-memory', 1, ?, ?, 'recorded', 'HUMAN_CLI', ?)")
    .run(summary, summary, now);
  legacy.prepare("INSERT INTO memory_anchors VALUES ('legacy-memory', 'src/legacy.ts', 'digest', 'abc123')").run();
  legacy.prepare("INSERT INTO memory_relations VALUES ('legacy-memory', 'legacy-target', 'SUPERSEDES', 'legacy relation', ?)").run(now);
  legacy.close();

  const migrated = new SqliteMemoryStore(path);
  try {
    migrated.initializeProject({ id: projectId, name: "legacy" });
    migrated.record(projectId, { type: "TODO", summary: "Captured by hook", sourceType: "HOOK" });
    assert.equal(migrated.search(projectId, "legacy decision", 10)
      .some(({ memory }) => memory.id === "legacy-memory"), true);
    assert.equal(migrated.search(projectId, "Captured hook", 10)
      .some(({ memory }) => memory.sourceType === "HOOK"), true);
    const legacyMemory = migrated.get(projectId, "legacy-memory");
    assert.equal(legacyMemory?.fileAnchors[0]?.path, "src/legacy.ts");
    assert.equal(legacyMemory?.relations[0]?.type, "SUPERSEDES");
    assert.equal(legacyMemory?.evidence[0]?.role, "ORIGIN");
    assert.equal(migrated.revisions(projectId, "legacy-memory").length, 1);
  } finally {
    migrated.close();
  }
  const migrationBackups = join(directory, "backups", "migrations");
  assert.equal(readdirSync(migrationBackups).filter((name) => name.endsWith(".db")).length, 1);
  const verified = new DatabaseSync(path, { readOnly: true });
  try {
    assert.ok(verified.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'legacy_memories_v1'").get());
    assert.equal(verified.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    verified.close();
  }
});

test("migrates schema v7 to Context OS v8 without changing existing knowledge", () => {
  const directory = mkdtempSync(join(tmpdir(), "polarbear-memory-v7-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "memory.db");
  const projectId = "99999999-9999-4999-8999-999999999999";
  const initial = new SqliteMemoryStore(path);
  initial.initializeProject({ id: projectId, name: "v7-fixture" });
  const memory = initial.record(projectId, { type: "DECISION", summary: "Preserve schema v7 knowledge" });
  initial.close();

  const v7 = new DatabaseSync(path);
  v7.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE usage_ledger;
    DROP TABLE context_packet_items;
    DROP TABLE context_packets;
    DROP TABLE retrieval_runs;
    DROP TABLE checkpoints;
    DROP TABLE observations;
    DROP TABLE execution_runs;
    DROP TABLE agent_sessions;
    DROP TABLE tasks;
    DELETE FROM schema_migrations WHERE version = 8;
  `);
  v7.close();

  const migrated = new SqliteMemoryStore(path);
  try {
    assert.equal(migrated.get(projectId, memory.id)?.summary, "Preserve schema v7 knowledge");
    const task = migrated.contextOs().createTask(projectId, {
      title: "Validate migration", objective: "Verify the additive v8 migration.",
    });
    assert.equal(migrated.contextOs().getTask(projectId, task.id)?.id, task.id);
  } finally {
    migrated.close();
  }
  assert.equal(readdirSync(join(directory, "backups", "migrations")).filter((name) => name.endsWith(".db")).length, 1);
  const verified = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal((verified.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 8);
    assert.equal(verified.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    verified.close();
  }
});

test("refuses to open a database created by a newer Engine", () => {
  const directory = mkdtempSync(join(tmpdir(), "polarbear-memory-newer-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "memory.db");
  const newer = new DatabaseSync(path);
  newer.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT; INSERT INTO schema_migrations VALUES (999, 'future');");
  newer.close();
  assert.throws(() => new SqliteMemoryStore(path), /newer than this Engine supports/);
});

test("edits create an auditable revision and physical purge keeps a tombstone audit", () => {
  const directory = mkdtempSync(join(tmpdir(), "polarbear-memory-edit-purge-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "memory.db");
  const projectId = "44444444-4444-4444-8444-444444444444";
  const store = new SqliteMemoryStore(path);
  store.initializeProject({ id: projectId, name: "fixture" });
  const memory = store.record(projectId, { type: "DECISION", summary: "Use the old API", content: "Original rationale." });

  const updated = store.update(projectId, memory.id, {
    summary: "Use the local Admin API",
    content: "The Desktop must communicate through the Engine.",
    reason: "Architecture decision was refined",
  });
  assert.equal(updated.summary, "Use the local Admin API");
  assert.equal(updated.verificationState, "UNVERIFIED");
  const revisions = store.revisions(projectId, memory.id);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0]?.reason, "edit:Architecture decision was refined");

  const purged = store.purge(projectId, memory.id, "User explicitly requested permanent deletion");
  assert.match(purged.purgedMemoryIdHash, /^[a-f0-9]{64}$/u);
  assert.equal(store.get(projectId, memory.id), undefined);
  store.close();

  const audit = new DatabaseSync(path, { readOnly: true });
  try {
    const row = audit.prepare("SELECT memory_id_hash, reason, actor_kind FROM purge_audit").get() as {
      memory_id_hash: string; reason: string; actor_kind: string;
    };
    assert.deepEqual({ ...row }, {
      memory_id_hash: purged.purgedMemoryIdHash,
      reason: "User explicitly requested permanent deletion",
      actor_kind: "HUMAN_CLI",
    });
    assert.equal((audit.prepare("SELECT count(*) AS count FROM knowledge_versions").get() as { count: number }).count, 0);
  } finally {
    audit.close();
  }
});

test("restores the preflight backup when a legacy migration fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "polarbear-memory-broken-migration-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "memory.db");
  const broken = new DatabaseSync(path);
  broken.exec("CREATE TABLE memories(id TEXT PRIMARY KEY, source_type TEXT NOT NULL CHECK (source_type IN ('CLI'))) STRICT; INSERT INTO memories VALUES ('preserve-me', 'CLI');");
  broken.close();
  assert.throws(() => new SqliteMemoryStore(path), /preflight backup was restored/);
  const restored = new DatabaseSync(path, { readOnly: true });
  try {
    const row = restored.prepare("SELECT * FROM memories").get() as { id: string; source_type: string };
    assert.equal(row.id, "preserve-me");
    assert.equal(row.source_type, "CLI");
  } finally { restored.close(); }
  assert.equal(readdirSync(join(directory, "backups", "migrations")).filter((name) => name.endsWith(".db")).length, 1);
});
