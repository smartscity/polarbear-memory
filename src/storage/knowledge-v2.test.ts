import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SCHEMA_VERSION, SqliteMemoryStore } from "./sqlite-store.js";
import { compileContext } from "../application/context.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { store: SqliteMemoryStore; projectId: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "polarbear-memory-v2-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "memory.db");
  const projectId = "77777777-7777-4777-8777-777777777777";
  const store = new SqliteMemoryStore(databasePath);
  store.initializeProject({ id: projectId, name: "v2-fixture" });
  return { store, projectId, databasePath };
}

test("fresh database uses canonical V2 tables and a rebuildable derived index", () => {
  const { store, projectId, databasePath } = fixture();
  const memory = store.record(projectId, { type: "FACT", summary: "SQLite is canonical truth" });
  store.rebuildSearchIndex();
  assert.equal(store.search(projectId, "canonical truth", 10)[0]?.memory.id, memory.id);
  store.close();

  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const names = new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    for (const name of [
      "workspaces", "projects", "sessions", "episodes", "evidence", "knowledge_units",
      "knowledge_versions", "knowledge_evidence", "entities", "knowledge_entities",
      "knowledge_relations", "knowledge_anchors", "lifecycle_assessments", "knowledge_fts", "context_deliveries",
    ]) assert.ok(names.has(name), `missing ${name}`);
    assert.equal(names.has("memories"), false);
    assert.equal((db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, CURRENT_SCHEMA_VERSION);
    assert.equal((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length, 0);
  } finally {
    db.close();
  }
});

test("schema v9 upgrades add Context delivery receipts without replacing canonical data", () => {
  const { store, projectId, databasePath } = fixture();
  const memory = store.record(projectId, { type: "DECISION", summary: "Preserve activation migration data" });
  store.close();

  const previous = new DatabaseSync(databasePath);
  previous.exec("DROP TABLE context_deliveries; DELETE FROM schema_migrations WHERE version = 10;");
  previous.close();

  const migrated = new SqliteMemoryStore(databasePath);
  try {
    assert.equal(migrated.get(projectId, memory.id)?.summary, memory.summary);
    const packet = migrated.contextOs().buildContext(projectId, { currentRequest: "Resume activation migration." });
    const receipt = migrated.contextOs().recordContextDelivery(projectId, packet.id, {
      provider: "migration-test", integrationMode: "ASSISTED", deliveryPoint: "TEST",
      status: "DELIVERED", sourceFingerprint: "migration-delivery",
    });
    assert.equal(receipt.status, "DELIVERED");
  } finally {
    migrated.close();
  }

  const verified = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal((verified.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version, 10);
    assert.equal((verified.prepare("SELECT count(*) AS count FROM context_deliveries").get() as { count: number }).count, 1);
  } finally {
    verified.close();
  }
});

test("knowledge update creates versions while supersede creates a new identity", () => {
  const { store, projectId } = fixture();
  try {
    const oldRule = store.record(projectId, {
      type: "DECISION",
      summary: "FAILED orders may retry",
      validFrom: "2026-01-01T00:00:00.000Z",
    });
    const edited = store.update(projectId, oldRule.id, {
      summary: "FAILED orders may retry after review",
      content: "This is a wording refinement of the same historical rule.",
      reason: "Clarify review requirement",
    });
    assert.equal(edited.id, oldRule.id);
    assert.equal(store.revisions(projectId, oldRule.id).length, 2);

    const currentRule = store.record(projectId, {
      type: "DECISION",
      summary: "FAILED is terminal and must not retry",
      validFrom: "2026-03-01T00:00:00.000Z",
    });
    store.addRelation(projectId, currentRule.id, oldRule.id, "SUPERSEDES", "State machine and regression test changed the rule");
    assert.equal(store.get(projectId, oldRule.id)?.lifecycleStatus, "SUPERSEDED");
    assert.equal(store.get(projectId, oldRule.id)?.validTo !== undefined, true);
    assert.equal(store.search(projectId, "FAILED retry", 10)[0]?.memory.id, currentRule.id);
    assert.ok(store.search(projectId, "How were FAILED orders handled before the new rule?", 10)
      .some(({ memory }) => memory.id === oldRule.id));
  } finally {
    store.close();
  }
});

test("evidence and engineering entities are many-to-many and entity-aware retrieval works", () => {
  const { store, projectId } = fixture();
  try {
    const session = store.upsertSession(projectId, {
      agentKind: "CODEX",
      externalSessionRefHash: "session-hash",
      branchName: "main",
      headStart: "aaa",
    });
    const episode = store.recordEpisode(projectId, {
      sessionId: session.id,
      type: "TEST_RESULT",
      sourceDigest: "test-result-digest",
      summary: "Settlement regression test passed",
      retentionClass: "DURABLE",
    });
    const evidence = store.recordEvidence(projectId, {
      episodeId: episode.id,
      type: "TEST",
      sourceRef: "test/SettlementStateMachine.test.ts",
      digest: "test-evidence-digest",
      commitSha: "bbb",
      trustLevel: "HIGH",
    });
    const entity = store.upsertEntity(projectId, {
      kind: "SERVICE",
      canonicalKey: "service://SettlementService",
      displayName: "SettlementService",
    });
    const first = store.record(projectId, { type: "CONSTRAINT", summary: "FAILED must not retry" });
    const second = store.record(projectId, { type: "PITFALL", summary: "Retry caused duplicate settlement" });
    for (const memory of [first, second]) {
      store.linkEvidence(projectId, memory.id, evidence.id, "SUPPORTS", 1000);
      store.linkEntity(projectId, memory.id, entity.id, "SUBJECT", 1000);
    }
    const hydrated = store.get(projectId, first.id);
    assert.equal(hydrated?.evidence.some((link) => link.evidence.id === evidence.id), true);
    assert.equal(hydrated?.entities.some((link) => link.entity.canonicalKey === "service://SettlementService"), true);
    assert.deepEqual(
      new Set(store.search(projectId, "SettlementService", 10).map(({ memory }) => memory.id)),
      new Set([first.id, second.id]),
    );
    const context = compileContext(store, projectId, "change SettlementService retry behavior", 1_000);
    assert.match(context.markdown, /Relevant constraints/);
    assert.match(context.markdown, /Known pitfalls/);
    assert.match(context.markdown, /test\/SettlementStateMachine\.test\.ts/);
    assert.match(context.markdown, /Entities: SettlementService/);
    assert.equal(store.upsertEntity(projectId, {
      kind: "SERVICE",
      canonicalKey: "service://SettlementService",
      displayName: "Settlement Service",
    }).id, entity.id);
  } finally {
    store.close();
  }
});

test("relation integrity supports bounded V2 relation types and rejects cycles", () => {
  const { store, projectId } = fixture();
  try {
    const a = store.record(projectId, { type: "FACT", summary: "Fact A" });
    const b = store.record(projectId, { type: "FACT", summary: "Fact B" });
    const c = store.record(projectId, { type: "FACT", summary: "Fact C" });
    store.addRelation(projectId, a.id, b.id, "DERIVES", "A derives from B");
    store.addRelation(projectId, b.id, c.id, "DERIVES", "B derives from C");
    assert.throws(() => store.addRelation(projectId, c.id, a.id, "DERIVES", "cycle"), /cannot create a cycle/);
    assert.throws(() => store.addRelation(projectId, a.id, a.id, "RELATED_TO", "self"), /cannot relate to itself/);
    store.addRelation(projectId, a.id, c.id, "EXTENDS", "A adds detail to C");
    store.addRelation(projectId, a.id, c.id, "DEPENDS_ON", "A assumes C");
    assert.deepEqual(
      new Set(store.get(projectId, a.id)?.relations.map((relation) => relation.type)),
      new Set(["DERIVES", "EXTENDS", "DEPENDS_ON"]),
    );
  } finally {
    store.close();
  }
});

test("current retrieval applies temporal and lifecycle filters", () => {
  const { store, projectId } = fixture();
  try {
    const expired = store.record(projectId, {
      type: "FACT",
      summary: "Legacy temporal API uses v1",
      validFrom: "2025-01-01T00:00:00.000Z",
      validTo: "2025-12-31T00:00:00.000Z",
    });
    const current = store.record(projectId, {
      type: "FACT",
      summary: "Current temporal API uses v2",
      validFrom: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(store.search(projectId, "temporal API", 10).map(({ memory }) => memory.id), [current.id]);
    assert.ok(store.search(projectId, "What did the temporal API use before?", 10)
      .some(({ memory }) => memory.id === expired.id));
  } finally {
    store.close();
  }
});

test("raw ingestion remains a short-term buffer while normalizing Session and Episode", () => {
  const { store, projectId, databasePath } = fixture();
  try {
    assert.equal(store.ingestRawEvent({
      id: "a".repeat(64),
      schemaVersion: 1,
      projectId,
      sessionRefHash: "b".repeat(64),
      agentKind: "claude-code",
      eventType: "CLAUDE_SESSION_END",
      payload: { reason: "completed" },
      payloadDigest: "c".repeat(64),
      occurredAt: "2026-08-28T00:00:00.000Z",
      expiresAt: "2026-09-04T00:00:00.000Z",
      ingestionVersion: 1,
    }), true);
    assert.equal(store.ingestRawEvent({
      id: "a".repeat(64),
      schemaVersion: 1,
      projectId,
      sessionRefHash: "b".repeat(64),
      agentKind: "claude-code",
      eventType: "CLAUDE_SESSION_END",
      payload: { reason: "completed" },
      payloadDigest: "c".repeat(64),
      occurredAt: "2026-08-28T00:00:00.000Z",
      expiresAt: "2026-09-04T00:00:00.000Z",
      ingestionVersion: 1,
    }), false);
  } finally {
    store.close();
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal((db.prepare("SELECT count(*) AS count FROM raw_events").get() as { count: number }).count, 1);
    const session = db.prepare("SELECT agent_kind, capture_status, ended_at FROM sessions").get() as Record<string, string>;
    assert.deepEqual({ ...session }, {
      agent_kind: "CLAUDE",
      capture_status: "ENDED",
      ended_at: "2026-08-28T00:00:00.000Z",
    });
    assert.equal((db.prepare("SELECT episode_type FROM episodes").get() as { episode_type: string }).episode_type, "AGENT_SESSION_END");
  } finally {
    db.close();
  }
});

test("generic Agent events normalize Codex sessions without a Codex-specific MCP adapter", () => {
  const { store, projectId, databasePath } = fixture();
  try {
    assert.equal(store.ingestRawEvent({
      id: "d".repeat(64),
      schemaVersion: 1,
      projectId,
      sessionRefHash: "e".repeat(64),
      agentKind: "codex",
      eventType: "AGENT_SESSION_END",
      payload: { reason: "completed" },
      payloadDigest: "f".repeat(64),
      occurredAt: "2026-08-29T00:00:00.000Z",
      expiresAt: "2026-09-05T00:00:00.000Z",
      ingestionVersion: 1,
    }), true);
  } finally {
    store.close();
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const session = database.prepare("SELECT agent_kind, capture_status FROM sessions").get() as Record<string, string>;
    assert.deepEqual({ ...session }, { agent_kind: "CODEX", capture_status: "ENDED" });
    const event = database.prepare("SELECT event_type FROM raw_events").get() as { event_type: string };
    assert.equal(event.event_type, "AGENT_SESSION_END");
  } finally {
    database.close();
  }
});
