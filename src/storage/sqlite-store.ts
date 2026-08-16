import { createHash, randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import type { Memory, MemorySearchResult, MemoryType, RecordMemoryInput, VerificationState } from "../domain/memory.js";
import type { EventEnvelope, StoredRawEvent } from "../domain/event.js";
import { validateRecordInput } from "../domain/memory.js";
import type { MemoryStore } from "../application/ports.js";

interface MemoryRow {
  id: string;
  project_id: string;
  type: string;
  summary: string;
  content: string;
  lifecycle_status: string;
  verification_state: string;
  confidence_milli: number;
  importance_milli: number;
  source_type: string;
  commit_sha: string | null;
  branch_name: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memories (
  row_id INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('DECISION','PITFALL','TASK_STATE','TODO')),
  summary TEXT NOT NULL CHECK (length(summary) > 0),
  content TEXT NOT NULL CHECK (length(content) > 0),
  lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (lifecycle_status IN ('ACTIVE','ARCHIVED','SUPERSEDED','REJECTED')),
  verification_state TEXT NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (verification_state IN ('UNVERIFIED','VERIFIED','DISPUTED')),
  confidence_milli INTEGER NOT NULL CHECK (confidence_milli BETWEEN 0 AND 1000),
  importance_milli INTEGER NOT NULL CHECK (importance_milli BETWEEN 0 AND 1000),
  source_type TEXT NOT NULL CHECK (source_type IN ('CLI','MCP','HOOK','FIXTURE')),
  commit_sha TEXT,
  branch_name TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS memories_project_status
  ON memories(project_id, lifecycle_status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS memories_project_content_hash
  ON memories(project_id, content_hash);

CREATE TABLE IF NOT EXISTS memory_files (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  repo_relative_path TEXT NOT NULL,
  PRIMARY KEY(memory_id, repo_relative_path)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('HUMAN_CLI','AGENT_MCP','SYSTEM')),
  created_at TEXT NOT NULL,
  UNIQUE(memory_id, revision_no)
) STRICT;

CREATE TABLE IF NOT EXISTS raw_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_ref_hash TEXT NOT NULL,
  agent_kind TEXT NOT NULL CHECK (agent_kind = 'claude-code'),
  event_type TEXT NOT NULL CHECK (event_type IN ('CLAUDE_STOP','CLAUDE_SESSION_END')),
  payload_redacted_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ingestion_version INTEGER NOT NULL,
  processed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS raw_events_session_pending
  ON raw_events(project_id, session_ref_hash, processed_at, occurred_at);

CREATE INDEX IF NOT EXISTS raw_events_expiry
  ON raw_events(project_id, expires_at);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  summary,
  content,
  type,
  content='memories',
  content_rowid='row_id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memory_fts(rowid, summary, content, type)
  VALUES (new.row_id, new.summary, new.content, new.type);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, summary, content, type)
  VALUES ('delete', old.row_id, old.summary, old.content, old.type);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, summary, content, type)
  VALUES ('delete', old.row_id, old.summary, old.content, old.type);
  INSERT INTO memory_fts(rowid, summary, content, type)
  VALUES (new.row_id, new.summary, new.content, new.type);
END;
`;

function ftsQuery(input: string): string {
  const terms = input.normalize("NFKC").match(/[\p{L}\p{N}_./:-]+/gu)?.slice(0, 20) ?? [];
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export class SqliteMemoryStore implements MemoryStore {
  readonly #db: DatabaseSync;

  constructor(databasePath: string, options: { busyTimeoutMs?: number } = {}) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 2_000;
    this.#db = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: busyTimeoutMs,
    });
    this.#db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA trusted_schema = OFF;`);
    this.#db.exec(SCHEMA);
    this.#migrateMemorySourceTypes();
    this.#db.exec(`
      INSERT OR IGNORE INTO memory_revisions(
        id, memory_id, revision_no, content, summary, reason, actor_kind, created_at
      )
      SELECT 'migration-v2-' || id, id, 1, content, summary, 'migrated', 'SYSTEM', created_at
      FROM memories;
    `);
    const migrationTime = new Date().toISOString();
    this.#db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(migrationTime);
    this.#db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)").run(migrationTime);
    this.#db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)").run(migrationTime);
  }

  initializeProject(project: { id: string; name: string }): void {
    const now = new Date().toISOString();
    this.#db.prepare(`
      INSERT INTO projects(id, display_name, created_at, last_seen_at, schema_version)
      VALUES (?, ?, ?, ?, 3)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, last_seen_at = excluded.last_seen_at, schema_version = 3
    `).run(project.id, project.name, now, now);
  }

  record(projectId: string, input: RecordMemoryInput): Memory {
    validateRecordInput(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    const content = input.content?.trim() || input.summary.trim();
    const confidence = input.confidence ?? 700;
    const importance = input.importance ?? 500;
    const sourceType = input.sourceType ?? "CLI";
    const hash = createHash("sha256").update(`${input.type}\0${input.summary.trim()}\0${content}`).digest("hex");

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.#db.prepare(
        "SELECT id FROM memories WHERE project_id = ? AND content_hash = ?",
      ).get(projectId, hash) as { id: string } | undefined;
      if (duplicate) {
        const insertFile = this.#db.prepare("INSERT OR IGNORE INTO memory_files(memory_id, repo_relative_path) VALUES (?, ?)");
        for (const file of new Set(input.files ?? [])) insertFile.run(duplicate.id, file);
        this.#db.exec("COMMIT");
        const existing = this.get(projectId, duplicate.id);
        if (!existing) throw new Error("Memory disappeared after deduplication.");
        return existing;
      }
      if (input.type === "TASK_STATE") {
        const activeStates = this.#db.prepare(`
          SELECT * FROM memories
          WHERE project_id = ? AND type = 'TASK_STATE' AND lifecycle_status = 'ACTIVE'
            AND coalesce(branch_name, '') = coalesce(?, '')
          ORDER BY updated_at DESC, id ASC
        `).all(projectId, input.branchName ?? null) as unknown as MemoryRow[];
        for (const row of activeStates) {
          const previous = this.#toMemory(row);
          this.#appendRevision(previous, `superseded-by:${id}`, sourceType === "MCP" ? "AGENT_MCP" : "SYSTEM", now);
          this.#db.prepare("UPDATE memories SET lifecycle_status = 'SUPERSEDED', updated_at = ? WHERE id = ?")
            .run(now, row.id);
        }
      }
      this.#db.prepare(`
        INSERT INTO memories(
          id, project_id, type, summary, content, confidence_milli, importance_milli,
          source_type, commit_sha, branch_name, content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, projectId, input.type, input.summary.trim(), content, confidence, importance,
        sourceType, input.commitSha ?? null, input.branchName ?? null, hash, now, now,
      );
      this.#db.prepare(`
        INSERT INTO memory_revisions(id, memory_id, revision_no, content, summary, reason, actor_kind, created_at)
        VALUES (?, ?, 1, ?, ?, 'recorded', ?, ?)
      `).run(
        randomUUID(),
        id,
        content,
        input.summary.trim(),
        sourceType === "CLI" ? "HUMAN_CLI" : sourceType === "MCP" ? "AGENT_MCP" : "SYSTEM",
        now,
      );
      const insertFile = this.#db.prepare("INSERT INTO memory_files(memory_id, repo_relative_path) VALUES (?, ?)");
      for (const file of new Set(input.files ?? [])) insertFile.run(id, file);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    const memory = this.get(projectId, id);
    if (!memory) throw new Error("Memory disappeared after insert.");
    return memory;
  }

  get(projectId: string, memoryId: string): Memory | undefined {
    const row = this.#db.prepare("SELECT * FROM memories WHERE project_id = ? AND id = ?").get(projectId, memoryId) as MemoryRow | undefined;
    return row ? this.#toMemory(row) : undefined;
  }

  search(projectId: string, query: string, limit: number): MemorySearchResult[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const rows = this.#db.prepare(`
      SELECT m.*, bm25(memory_fts, 8.0, 2.0, 1.0) AS fts_rank
      FROM memory_fts
      JOIN memories m ON m.row_id = memory_fts.rowid
      WHERE memory_fts MATCH ? AND m.project_id = ? AND m.lifecycle_status = 'ACTIVE'
      ORDER BY fts_rank ASC, m.importance_milli DESC, m.updated_at DESC, m.id ASC
      LIMIT ?
    `).all(match, projectId, limit) as unknown as Array<MemoryRow & { fts_rank: number }>;
    return rows.map((row, index) => ({ memory: this.#toMemory(row), rank: index + 1 }));
  }

  recent(projectId: string, limit: number): MemorySearchResult[] {
    const rows = this.#db.prepare(`
      SELECT * FROM memories
      WHERE project_id = ? AND lifecycle_status = 'ACTIVE'
      ORDER BY importance_milli DESC, updated_at DESC, id ASC LIMIT ?
    `).all(projectId, limit) as unknown as MemoryRow[];
    return rows.map((row, index) => ({ memory: this.#toMemory(row), rank: index + 1 }));
  }

  verify(
    projectId: string,
    memoryId: string,
    state: VerificationState,
    reason: string,
    actor: "HUMAN_CLI" | "AGENT_MCP" = "AGENT_MCP",
  ): Memory {
    this.#validateReason(reason, "Verification");
    const memory = this.get(projectId, memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    if (memory.verificationState === state) return memory;
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE memories SET verification_state = ?, updated_at = ? WHERE project_id = ? AND id = ?")
        .run(state, now, projectId, memoryId);
      this.#appendRevision(memory, `verification:${state}:${reason.trim()}`, actor, now);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    const updated = this.get(projectId, memoryId);
    if (!updated) throw new Error(`Memory not found after verification: ${memoryId}`);
    return updated;
  }

  archive(
    projectId: string,
    memoryId: string,
    reason: string,
    actor: "HUMAN_CLI" | "AGENT_MCP" = "AGENT_MCP",
  ): Memory {
    this.#validateReason(reason, "Archive");
    const memory = this.get(projectId, memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    if (memory.lifecycleStatus === "ARCHIVED") return memory;
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE memories SET lifecycle_status = 'ARCHIVED', updated_at = ? WHERE project_id = ? AND id = ?")
        .run(now, projectId, memoryId);
      this.#appendRevision(memory, `archive:${reason.trim()}`, actor, now);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    const updated = this.get(projectId, memoryId);
    if (!updated) throw new Error(`Memory not found after archive: ${memoryId}`);
    return updated;
  }

  ingestRawEvent(event: EventEnvelope): boolean {
    const result = this.#db.prepare(`
      INSERT OR IGNORE INTO raw_events(
        id, project_id, session_ref_hash, agent_kind, event_type,
        payload_redacted_json, payload_digest, occurred_at, expires_at, ingestion_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.projectId,
      event.sessionRefHash,
      event.agentKind,
      event.eventType,
      JSON.stringify(event.payload),
      event.payloadDigest,
      event.occurredAt,
      event.expiresAt,
      event.ingestionVersion,
    );
    return Number(result.changes) > 0;
  }

  unprocessedRawEvents(projectId: string, sessionRefHash: string): StoredRawEvent[] {
    const rows = this.#db.prepare(`
      SELECT * FROM raw_events
      WHERE project_id = ? AND session_ref_hash = ? AND processed_at IS NULL
      ORDER BY occurred_at ASC, id ASC
    `).all(projectId, sessionRefHash) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: String(row.id),
      schemaVersion: 1,
      projectId: String(row.project_id),
      sessionRefHash: String(row.session_ref_hash),
      agentKind: "claude-code",
      eventType: String(row.event_type) as StoredRawEvent["eventType"],
      payload: JSON.parse(String(row.payload_redacted_json)) as Record<string, string | boolean>,
      payloadDigest: String(row.payload_digest),
      occurredAt: String(row.occurred_at),
      expiresAt: String(row.expires_at),
      ingestionVersion: 1,
      ...(row.processed_at ? { processedAt: String(row.processed_at) } : {}),
    }));
  }

  pendingEndedSessions(projectId: string): string[] {
    const rows = this.#db.prepare(`
      SELECT DISTINCT session_ref_hash
      FROM raw_events
      WHERE project_id = ? AND event_type = 'CLAUDE_SESSION_END' AND processed_at IS NULL
      ORDER BY session_ref_hash
    `).all(projectId) as Array<{ session_ref_hash: string }>;
    return rows.map((row) => row.session_ref_hash);
  }

  markRawEventProcessed(projectId: string, eventId: string, processedAt: string): void {
    this.#db.prepare("UPDATE raw_events SET processed_at = coalesce(processed_at, ?) WHERE project_id = ? AND id = ?")
      .run(processedAt, projectId, eventId);
  }

  deleteExpiredRawEvents(projectId: string, now: string): number {
    const result = this.#db.prepare("DELETE FROM raw_events WHERE project_id = ? AND expires_at <= ?")
      .run(projectId, now);
    return Number(result.changes);
  }

  status(projectId: string): Record<string, number> {
    const result: Record<string, number> = { total: 0 };
    let total = 0;
    const rows = this.#db.prepare(`
      SELECT lifecycle_status AS status, count(*) AS count
      FROM memories WHERE project_id = ? GROUP BY lifecycle_status
    `).all(projectId) as Array<{ status: string; count: number }>;
    for (const row of rows) {
      result[row.status.toLowerCase()] = row.count;
      total += row.count;
    }
    result.total = total;
    return result;
  }

  rebuildSearchIndex(): void {
    this.#db.exec("INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')");
  }

  backup(destination: string): Promise<number> {
    return backup(this.#db, destination);
  }

  close(): void {
    this.#db.close();
  }

  #migrateMemorySourceTypes(): void {
    const row = this.#db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'memories'")
      .get() as { sql: string } | undefined;
    if (!row || row.sql.includes("'HOOK'")) return;
    this.#db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.#db.exec(`
        BEGIN IMMEDIATE;
        DROP TRIGGER IF EXISTS memories_ai;
        DROP TRIGGER IF EXISTS memories_ad;
        DROP TRIGGER IF EXISTS memories_au;
        DROP TABLE IF EXISTS memory_fts;
        CREATE TABLE memories_v3 (
          row_id INTEGER PRIMARY KEY,
          id TEXT NOT NULL UNIQUE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK (type IN ('DECISION','PITFALL','TASK_STATE','TODO')),
          summary TEXT NOT NULL CHECK (length(summary) > 0),
          content TEXT NOT NULL CHECK (length(content) > 0),
          lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE'
            CHECK (lifecycle_status IN ('ACTIVE','ARCHIVED','SUPERSEDED','REJECTED')),
          verification_state TEXT NOT NULL DEFAULT 'UNVERIFIED'
            CHECK (verification_state IN ('UNVERIFIED','VERIFIED','DISPUTED')),
          confidence_milli INTEGER NOT NULL CHECK (confidence_milli BETWEEN 0 AND 1000),
          importance_milli INTEGER NOT NULL CHECK (importance_milli BETWEEN 0 AND 1000),
          source_type TEXT NOT NULL CHECK (source_type IN ('CLI','MCP','HOOK','FIXTURE')),
          commit_sha TEXT,
          branch_name TEXT,
          content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO memories_v3 SELECT * FROM memories;
        DROP TABLE memories;
        ALTER TABLE memories_v3 RENAME TO memories;
        CREATE INDEX memories_project_status
          ON memories(project_id, lifecycle_status, updated_at DESC);
        CREATE UNIQUE INDEX memories_project_content_hash
          ON memories(project_id, content_hash);
        CREATE VIRTUAL TABLE memory_fts USING fts5(
          summary, content, type, content='memories', content_rowid='row_id', tokenize='unicode61'
        );
        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memory_fts(rowid, summary, content, type)
          VALUES (new.row_id, new.summary, new.content, new.type);
        END;
        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, summary, content, type)
          VALUES ('delete', old.row_id, old.summary, old.content, old.type);
        END;
        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memory_fts(memory_fts, rowid, summary, content, type)
          VALUES ('delete', old.row_id, old.summary, old.content, old.type);
          INSERT INTO memory_fts(rowid, summary, content, type)
          VALUES (new.row_id, new.summary, new.content, new.type);
        END;
        INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');
        COMMIT;
      `);
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* transaction may not have started */ }
      throw error;
    } finally {
      this.#db.exec("PRAGMA foreign_keys = ON");
    }
    const violations = this.#db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) throw new Error("Memory database migration produced foreign-key violations.");
  }

  #toMemory(row: MemoryRow): Memory {
    const files = this.#db.prepare("SELECT repo_relative_path FROM memory_files WHERE memory_id = ? ORDER BY repo_relative_path")
      .all(row.id) as Array<{ repo_relative_path: string }>;
    return {
      id: row.id,
      projectId: row.project_id,
      type: row.type as MemoryType,
      summary: row.summary,
      content: row.content,
      lifecycleStatus: row.lifecycle_status as Memory["lifecycleStatus"],
      verificationState: row.verification_state as Memory["verificationState"],
      confidence: row.confidence_milli,
      importance: row.importance_milli,
      sourceType: row.source_type as Memory["sourceType"],
      ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
      ...(row.branch_name ? { branchName: row.branch_name } : {}),
      files: files.map((file) => file.repo_relative_path),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #validateReason(reason: string, label: string): void {
    if (reason.trim().length === 0 || Buffer.byteLength(reason, "utf8") > 2_048) {
      throw new Error(`${label} reason must contain 1–2048 bytes.`);
    }
  }

  #appendRevision(memory: Memory, reason: string, actor: "HUMAN_CLI" | "AGENT_MCP" | "SYSTEM", now: string): void {
    const next = this.#db.prepare("SELECT coalesce(max(revision_no), 0) + 1 AS revision FROM memory_revisions WHERE memory_id = ?")
      .get(memory.id) as { revision: number };
    this.#db.prepare(`
      INSERT INTO memory_revisions(id, memory_id, revision_no, content, summary, reason, actor_kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), memory.id, next.revision, memory.content, memory.summary, reason, actor, now);
  }
}
