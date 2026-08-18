import { createHash, randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Memory, MemorySearchResult, MemoryType, RecordMemoryInput, VerificationState } from "../domain/memory.js";
import type {
  CompletionState,
  CorrectnessRisk,
  FileAnchor,
  MaintenanceAction,
  MemoryRelationType,
  MemoryRevision,
} from "../domain/lifecycle.js";
import { ASSESSOR_VERSION, POLICY_VERSION } from "../domain/lifecycle.js";
import type { EventEnvelope, StoredRawEvent } from "../domain/event.js";
import { validateRecordInput } from "../domain/memory.js";
import type { MemoryStore } from "../application/ports.js";
import { acquireClientLease, type ClientLease } from "./client-lease.js";

interface MemoryRow {
  id: string;
  project_id: string;
  type: string;
  summary: string;
  content: string;
  lifecycle_status: string;
  verification_state: string;
  correctness_risk: string;
  relevance_milli: number;
  completion_state: string;
  confidence_milli: number;
  importance_milli: number;
  source_type: string;
  commit_sha: string | null;
  branch_name: string | null;
  created_at: string;
  updated_at: string;
  last_checked_commit: string | null;
  last_assessed_at: string | null;
  completed_at: string | null;
  restore_protected_until: string | null;
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
  correctness_risk TEXT NOT NULL DEFAULT 'LOW'
    CHECK (correctness_risk IN ('LOW','MEDIUM','HIGH')),
  relevance_milli INTEGER NOT NULL DEFAULT 500 CHECK (relevance_milli BETWEEN 0 AND 1000),
  completion_state TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (completion_state IN ('OPEN','COMPLETED','CANCELLED')),
  confidence_milli INTEGER NOT NULL CHECK (confidence_milli BETWEEN 0 AND 1000),
  importance_milli INTEGER NOT NULL CHECK (importance_milli BETWEEN 0 AND 1000),
  source_type TEXT NOT NULL CHECK (source_type IN ('CLI','MCP','HOOK','FIXTURE')),
  commit_sha TEXT,
  branch_name TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_checked_commit TEXT,
  last_assessed_at TEXT,
  completed_at TEXT,
  restore_protected_until TEXT
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

CREATE TABLE IF NOT EXISTS memory_anchors (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  repo_relative_path TEXT NOT NULL,
  content_digest TEXT,
  captured_commit TEXT,
  PRIMARY KEY(memory_id, repo_relative_path)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_relations (
  source_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('SUPERSEDES','CONTRADICTS')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_memory_id, target_memory_id, relation_type),
  CHECK (source_memory_id <> target_memory_id)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_usage_stats (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  positive_feedback_count INTEGER NOT NULL DEFAULT 0,
  negative_feedback_count INTEGER NOT NULL DEFAULT 0,
  last_candidate_at TEXT,
  last_selected_at TEXT,
  last_feedback_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS lifecycle_assessments (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  previous_risk TEXT NOT NULL,
  new_risk TEXT NOT NULL,
  previous_lifecycle TEXT NOT NULL,
  new_lifecycle TEXT NOT NULL,
  relevance_milli INTEGER NOT NULL,
  checked_commit TEXT,
  reason_codes_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  assessor_version TEXT NOT NULL,
  assessed_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS maintenance_cursors (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  checked_commit TEXT,
  updated_at TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS purge_audit (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  memory_id_hash TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'HUMAN_CLI'),
  created_at TEXT NOT NULL
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

export const CURRENT_SCHEMA_VERSION = 5;

function quoteSqliteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function existingSchemaVersion(db: DatabaseSync): { hasData: boolean; version: number } {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('memories', 'schema_migrations')").all() as Array<{ name: string }>;
  const hasData = tables.some((row) => row.name === "memories");
  if (!tables.some((row) => row.name === "schema_migrations")) return { hasData, version: 0 };
  const row = db.prepare("SELECT coalesce(max(version), 0) AS version FROM schema_migrations").get() as { version: number };
  return { hasData, version: row.version };
}

function ftsQuery(input: string): string {
  const terms = input.normalize("NFKC").match(/[\p{L}\p{N}_./:-]+/gu)?.slice(0, 20) ?? [];
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export class SqliteMemoryStore implements MemoryStore {
  readonly #db!: DatabaseSync;
  readonly #lease: ClientLease | undefined;
  #closed = false;

  constructor(databasePath: string, options: { busyTimeoutMs?: number } = {}) {
    this.#lease = acquireClientLease(databasePath);
    const busyTimeoutMs = options.busyTimeoutMs ?? 2_000;
    try {
      this.#db = new DatabaseSync(databasePath, {
        allowExtension: false,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        timeout: busyTimeoutMs,
      });
      const existing = existingSchemaVersion(this.#db);
      if (existing.version > CURRENT_SCHEMA_VERSION) {
        this.#db.close();
        this.#lease?.close();
        throw new Error(`Database schema ${existing.version} is newer than this Engine supports (${CURRENT_SCHEMA_VERSION}). Upgrade Polarbear Memory before writing.`);
      }
      let migrationBackupPath: string | undefined;
      if (databasePath !== ":memory:" && existing.hasData && existing.version < CURRENT_SCHEMA_VERSION) {
        const migrationBackupDirectory = join(dirname(databasePath), "backups", "migrations");
        mkdirSync(migrationBackupDirectory, { recursive: true, mode: 0o700 });
        const backupPath = join(migrationBackupDirectory, `schema-${existing.version}-to-${CURRENT_SCHEMA_VERSION}-${Date.now()}.db`);
        if (existsSync(backupPath)) throw new Error("Migration backup target already exists.");
        this.#db.exec(`VACUUM INTO ${quoteSqliteLiteral(backupPath)}`);
        migrationBackupPath = backupPath;
      }
      try {
        this.#db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA trusted_schema = OFF;`);
        this.#db.exec(SCHEMA);
        this.#migrateMemorySourceTypes();
        this.#migrateLifecycleColumns();
        this.#migrateUsageColumns();
        this.#db.exec(`
        CREATE INDEX IF NOT EXISTS memories_maintenance
          ON memories(project_id, lifecycle_status, last_checked_commit, completed_at);
      `);
        this.#db.exec(`
        INSERT OR IGNORE INTO memory_revisions(
          id, memory_id, revision_no, content, summary, reason, actor_kind, created_at
        )
        SELECT 'migration-v2-' || id, id, 1, content, summary, 'migrated', 'SYSTEM', created_at
        FROM memories;
        INSERT OR IGNORE INTO memory_usage_stats(memory_id) SELECT id FROM memories;
        INSERT OR IGNORE INTO memory_anchors(memory_id, repo_relative_path)
          SELECT memory_id, repo_relative_path FROM memory_files;
      `);
        const migrationTime = new Date().toISOString();
        this.#db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(migrationTime);
        this.#db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)").run(migrationTime);
        this.#db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, ?)").run(migrationTime);
        this.#db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, ?)").run(migrationTime);
        this.#db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(CURRENT_SCHEMA_VERSION, migrationTime);
      } catch (error) {
        this.#db.close();
        if (migrationBackupPath) {
          const failedPath = `${databasePath}.migration-failed-${Date.now()}`;
          if (existsSync(databasePath)) renameSync(databasePath, failedPath);
          copyFileSync(migrationBackupPath, databasePath);
          for (const suffix of ["-wal", "-shm"]) {
            const sidecar = `${databasePath}${suffix}`;
            if (existsSync(sidecar)) renameSync(sidecar, `${failedPath}${suffix}`);
          }
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(`Database migration failed and the preflight backup was restored. Cause: ${cause}`);
        }
        throw error;
      }
    } catch (error) {
      try { this.#db?.close(); } catch { /* constructor may already have closed it */ }
      this.#lease?.close();
      throw error;
    }
  }

  initializeProject(project: { id: string; name: string }): void {
    const now = new Date().toISOString();
    this.#db.prepare(`
      INSERT INTO projects(id, display_name, created_at, last_seen_at, schema_version)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, last_seen_at = excluded.last_seen_at, schema_version = excluded.schema_version
    `).run(project.id, project.name, now, now, CURRENT_SCHEMA_VERSION);
  }

  record(projectId: string, input: RecordMemoryInput): Memory {
    validateRecordInput(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    const content = input.content?.trim() || input.summary.trim();
    const confidence = input.confidence ?? 700;
    const importance = input.importance ?? 500;
    const sourceType = input.sourceType ?? "CLI";
    const completionState = input.completionState ?? "OPEN";
    const hash = createHash("sha256").update(`${input.type}\0${input.summary.trim()}\0${content}`).digest("hex");
    const supersededIds: string[] = [];

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.#db.prepare(
        "SELECT id FROM memories WHERE project_id = ? AND content_hash = ?",
      ).get(projectId, hash) as { id: string } | undefined;
      if (duplicate) {
        const insertFile = this.#db.prepare("INSERT OR IGNORE INTO memory_files(memory_id, repo_relative_path) VALUES (?, ?)");
        const insertEmptyAnchor = this.#db.prepare("INSERT OR IGNORE INTO memory_anchors(memory_id, repo_relative_path) VALUES (?, ?)");
        for (const file of new Set(input.files ?? [])) {
          insertFile.run(duplicate.id, file);
          insertEmptyAnchor.run(duplicate.id, file);
        }
        const upsertAnchor = this.#db.prepare(`
          INSERT INTO memory_anchors(memory_id, repo_relative_path, content_digest, captured_commit)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(memory_id, repo_relative_path) DO UPDATE SET
            content_digest = excluded.content_digest,
            captured_commit = excluded.captured_commit
        `);
        for (const anchor of input.fileAnchors ?? []) {
          upsertAnchor.run(duplicate.id, anchor.path, anchor.contentDigest ?? null, anchor.capturedCommit ?? null);
        }
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
          this.#db.prepare(`
            INSERT INTO lifecycle_assessments(
              id, memory_id, previous_risk, new_risk, previous_lifecycle, new_lifecycle,
              relevance_milli, checked_commit, reason_codes_json, policy_version, assessor_version, assessed_at
            ) VALUES (?, ?, ?, ?, 'ACTIVE', 'SUPERSEDED', ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            row.id,
            previous.correctnessRisk,
            previous.correctnessRisk,
            previous.relevance,
            input.commitSha ?? previous.lastCheckedCommit ?? null,
            JSON.stringify(["TASK_STATE_SINGLE_ACTIVE"]),
            POLICY_VERSION,
            ASSESSOR_VERSION,
            now,
          );
          supersededIds.push(row.id);
        }
      }
      this.#db.prepare(`
        INSERT INTO memories(
          id, project_id, type, summary, content, confidence_milli, importance_milli,
          relevance_milli, completion_state, completed_at, source_type, commit_sha, branch_name,
          content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, projectId, input.type, input.summary.trim(), content, confidence, importance,
        completionState === "OPEN" ? importance : 0,
        completionState,
        completionState === "OPEN" ? null : now,
        sourceType,
        input.commitSha ?? null,
        input.branchName ?? null,
        hash,
        now,
        now,
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
      const insertEmptyAnchor = this.#db.prepare("INSERT OR IGNORE INTO memory_anchors(memory_id, repo_relative_path) VALUES (?, ?)");
      for (const file of new Set(input.files ?? [])) {
        insertFile.run(id, file);
        insertEmptyAnchor.run(id, file);
      }
      const insertAnchor = this.#db.prepare(`
        INSERT INTO memory_anchors(memory_id, repo_relative_path, content_digest, captured_commit)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(memory_id, repo_relative_path) DO UPDATE SET
          content_digest = excluded.content_digest,
          captured_commit = excluded.captured_commit
      `);
      for (const anchor of input.fileAnchors ?? []) {
        insertAnchor.run(id, anchor.path, anchor.contentDigest ?? null, anchor.capturedCommit ?? null);
      }
      this.#db.prepare("INSERT INTO memory_usage_stats(memory_id) VALUES (?)").run(id);
      for (const targetId of supersededIds) {
        this.#db.prepare(`
          INSERT INTO memory_relations(source_memory_id, target_memory_id, relation_type, reason, created_at)
          VALUES (?, ?, 'SUPERSEDES', 'task-state-single-active', ?)
        `).run(id, targetId, now);
      }
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

  update(projectId: string, memoryId: string, input: { summary: string; content: string; reason: string }): Memory {
    this.#validateReason(input.reason, "Edit");
    const current = this.get(projectId, memoryId);
    if (!current) throw new Error(`Memory not found: ${memoryId}`);
    validateRecordInput({ type: current.type, summary: input.summary, content: input.content });
    const summary = input.summary.trim();
    const content = input.content.trim();
    const hash = createHash("sha256").update(`${current.type}\0${summary}\0${content}`).digest("hex");
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        UPDATE memories SET summary = ?, content = ?, content_hash = ?, verification_state = 'UNVERIFIED',
          updated_at = ? WHERE project_id = ? AND id = ?
      `).run(summary, content, hash, now, projectId, memoryId);
      this.#appendRevision({ ...current, summary, content }, `edit:${input.reason.trim()}`, "HUMAN_CLI", now);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    const updated = this.get(projectId, memoryId);
    if (!updated) throw new Error(`Memory not found after edit: ${memoryId}`);
    return updated;
  }

  purge(projectId: string, memoryId: string, reason: string): { purgedMemoryIdHash: string } {
    this.#validateReason(reason, "Purge");
    const memory = this.get(projectId, memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    const purgedMemoryIdHash = createHash("sha256").update(memory.id).digest("hex");
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        INSERT INTO purge_audit(id, project_id, memory_id_hash, memory_type, reason, actor_kind, created_at)
        VALUES (?, ?, ?, ?, ?, 'HUMAN_CLI', ?)
      `).run(randomUUID(), projectId, purgedMemoryIdHash, memory.type, reason.trim(), now);
      this.#db.prepare("DELETE FROM memories WHERE project_id = ? AND id = ?").run(projectId, memoryId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return { purgedMemoryIdHash };
  }

  revisions(projectId: string, memoryId: string): MemoryRevision[] {
    if (!this.get(projectId, memoryId)) throw new Error(`Memory not found: ${memoryId}`);
    const rows = this.#db.prepare(`
      SELECT revision_no, content, summary, reason, actor_kind, created_at
      FROM memory_revisions WHERE memory_id = ? ORDER BY revision_no DESC
    `).all(memoryId) as Array<{
      revision_no: number;
      content: string;
      summary: string;
      reason: string;
      actor_kind: MemoryRevision["actor"];
      created_at: string;
    }>;
    return rows.map((row) => ({
      revision: row.revision_no,
      content: row.content,
      summary: row.summary,
      reason: row.reason,
      actor: row.actor_kind,
      createdAt: row.created_at,
    }));
  }

  search(projectId: string, query: string, limit: number): MemorySearchResult[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const rows = this.#db.prepare(`
      SELECT m.*, bm25(memory_fts, 8.0, 2.0, 1.0) AS fts_rank
      FROM memory_fts
      JOIN memories m ON m.row_id = memory_fts.rowid
      WHERE memory_fts MATCH ? AND m.project_id = ? AND m.lifecycle_status = 'ACTIVE'
        AND m.completion_state = 'OPEN'
      ORDER BY CASE m.correctness_risk WHEN 'LOW' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
        fts_rank ASC, m.relevance_milli DESC, m.importance_milli DESC, m.updated_at DESC, m.id ASC
      LIMIT ?
    `).all(match, projectId, limit) as unknown as Array<MemoryRow & { fts_rank: number }>;
    return rows.map((row, index) => ({ memory: this.#toMemory(row), rank: index + 1 }));
  }

  recent(projectId: string, limit: number): MemorySearchResult[] {
    const rows = this.#db.prepare(`
      SELECT * FROM memories
      WHERE project_id = ? AND lifecycle_status = 'ACTIVE' AND completion_state = 'OPEN'
      ORDER BY CASE correctness_risk WHEN 'LOW' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
        relevance_milli DESC, importance_milli DESC, updated_at DESC, id ASC LIMIT ?
    `).all(projectId, limit) as unknown as MemoryRow[];
    return rows.map((row, index) => ({ memory: this.#toMemory(row), rank: index + 1 }));
  }

  list(
    projectId: string,
    options: { query?: string; status?: Memory["lifecycleStatus"]; type?: MemoryType; limit: number; offset: number },
  ): Memory[] {
    const limit = Math.max(1, Math.min(options.limit, 100));
    const offset = Math.max(0, options.offset);
    const query = options.query?.trim();
    if (query) {
      const match = ftsQuery(query);
      if (!match) return [];
      const rows = this.#db.prepare(`
        SELECT m.* FROM memory_fts
        JOIN memories m ON m.row_id = memory_fts.rowid
        WHERE memory_fts MATCH ? AND m.project_id = ?
          AND (? IS NULL OR m.lifecycle_status = ?)
          AND (? IS NULL OR m.type = ?)
        ORDER BY bm25(memory_fts, 8.0, 2.0, 1.0), m.updated_at DESC, m.id ASC
        LIMIT ? OFFSET ?
      `).all(
        match,
        projectId,
        options.status ?? null,
        options.status ?? null,
        options.type ?? null,
        options.type ?? null,
        limit,
        offset,
      ) as unknown as MemoryRow[];
      return rows.map((row) => this.#toMemory(row));
    }
    const rows = this.#db.prepare(`
      SELECT * FROM memories WHERE project_id = ?
        AND (? IS NULL OR lifecycle_status = ?)
        AND (? IS NULL OR type = ?)
      ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?
    `).all(
      projectId,
      options.status ?? null,
      options.status ?? null,
      options.type ?? null,
      options.type ?? null,
      limit,
      offset,
    ) as unknown as MemoryRow[];
    return rows.map((row) => this.#toMemory(row));
  }

  verify(
    projectId: string,
    memoryId: string,
    state: VerificationState,
    reason: string,
    actor: "HUMAN_CLI" | "AGENT_MCP" = "AGENT_MCP",
    evidence: { anchors?: FileAnchor[]; checkedCommit?: string } = {},
  ): Memory {
    this.#validateReason(reason, "Verification");
    const memory = this.get(projectId, memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        UPDATE memories SET verification_state = ?, correctness_risk = 'LOW',
          last_checked_commit = coalesce(?, last_checked_commit), last_assessed_at = ?, updated_at = ?
        WHERE project_id = ? AND id = ?
      `).run(state, evidence.checkedCommit ?? null, now, now, projectId, memoryId);
      const upsertAnchor = this.#db.prepare(`
        INSERT INTO memory_anchors(memory_id, repo_relative_path, content_digest, captured_commit)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(memory_id, repo_relative_path) DO UPDATE SET
          content_digest = excluded.content_digest, captured_commit = excluded.captured_commit
      `);
      for (const anchor of evidence.anchors ?? []) {
        upsertAnchor.run(memoryId, anchor.path, anchor.contentDigest ?? null, anchor.capturedCommit ?? null);
      }
      this.#db.prepare(`
        INSERT INTO lifecycle_assessments(
          id, memory_id, previous_risk, new_risk, previous_lifecycle, new_lifecycle,
          relevance_milli, checked_commit, reason_codes_json, policy_version, assessor_version, assessed_at
        ) VALUES (?, ?, ?, 'LOW', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        memoryId,
        memory.correctnessRisk,
        memory.lifecycleStatus,
        memory.lifecycleStatus,
        memory.relevance,
        evidence.checkedCommit ?? null,
        JSON.stringify([actor === "HUMAN_CLI" ? "HUMAN_VERIFIED_CURRENT_SOURCE" : "AGENT_VERIFIED_CURRENT_SOURCE"]),
        POLICY_VERSION,
        ASSESSOR_VERSION,
        now,
      );
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
      this.#db.prepare(`
        INSERT INTO lifecycle_assessments(
          id, memory_id, previous_risk, new_risk, previous_lifecycle, new_lifecycle,
          relevance_milli, checked_commit, reason_codes_json, policy_version, assessor_version, assessed_at
        ) VALUES (?, ?, ?, ?, ?, 'ARCHIVED', ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        memoryId,
        memory.correctnessRisk,
        memory.correctnessRisk,
        memory.lifecycleStatus,
        memory.relevance,
        memory.lastCheckedCommit ?? null,
        JSON.stringify([actor === "HUMAN_CLI" ? "HUMAN_ARCHIVE" : "AGENT_ARCHIVE"]),
        POLICY_VERSION,
        ASSESSOR_VERSION,
        now,
      );
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

  restore(projectId: string, memoryId: string, reason: string): Memory {
    this.#validateReason(reason, "Restore");
    const memory = this.get(projectId, memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    if (memory.lifecycleStatus !== "ARCHIVED") throw new Error("Only archived Memory can be restored.");
    const now = new Date();
    const protectedUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        UPDATE memories SET lifecycle_status = 'ACTIVE', restore_protected_until = ?, updated_at = ?
        WHERE project_id = ? AND id = ?
      `).run(protectedUntil, now.toISOString(), projectId, memoryId);
      this.#db.prepare(`
        INSERT INTO lifecycle_assessments(
          id, memory_id, previous_risk, new_risk, previous_lifecycle, new_lifecycle,
          relevance_milli, checked_commit, reason_codes_json, policy_version, assessor_version, assessed_at
        ) VALUES (?, ?, ?, ?, 'ARCHIVED', 'ACTIVE', ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        memoryId,
        memory.correctnessRisk,
        memory.correctnessRisk,
        memory.relevance,
        memory.lastCheckedCommit ?? null,
        JSON.stringify(["HUMAN_RESTORE_GRACE_30D"]),
        POLICY_VERSION,
        ASSESSOR_VERSION,
        now.toISOString(),
      );
      this.#appendRevision(memory, `restore:${reason.trim()}`, "HUMAN_CLI", now.toISOString());
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    const restored = this.get(projectId, memoryId);
    if (!restored) throw new Error(`Memory not found after restore: ${memoryId}`);
    return restored;
  }

  complete(
    projectId: string,
    memoryId: string,
    state: Exclude<CompletionState, "OPEN">,
    reason: string,
    clock = new Date(),
  ): Memory {
    this.#validateReason(reason, "Completion");
    const memory = this.get(projectId, memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    if (memory.type !== "TASK_STATE" && memory.type !== "TODO") {
      throw new Error("Only TASK_STATE and TODO Memory can be completed or cancelled.");
    }
    if (memory.completionState === state) return memory;
    const now = clock.toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        UPDATE memories SET completion_state = ?, completed_at = ?, relevance_milli = 0, updated_at = ?
        WHERE project_id = ? AND id = ?
      `).run(state, now, now, projectId, memoryId);
      this.#appendRevision(memory, `completion:${state}:${reason.trim()}`, "HUMAN_CLI", now);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    const completed = this.get(projectId, memoryId);
    if (!completed) throw new Error(`Memory not found after completion: ${memoryId}`);
    return completed;
  }

  addRelation(
    projectId: string,
    sourceMemoryId: string,
    targetMemoryId: string,
    type: MemoryRelationType,
    reason: string,
  ): void {
    this.#validateReason(reason, "Relation");
    if (sourceMemoryId === targetMemoryId) throw new Error("A Memory cannot relate to itself.");
    const source = this.get(projectId, sourceMemoryId);
    const target = this.get(projectId, targetMemoryId);
    if (!source || !target) throw new Error("Both related Memory records must exist in this project.");
    if (type === "SUPERSEDES") {
      const cycle = this.#db.prepare(`
        WITH RECURSIVE superseded(memory_id) AS (
          SELECT target_memory_id
          FROM memory_relations
          WHERE source_memory_id = ? AND relation_type = 'SUPERSEDES'
          UNION
          SELECT relation.target_memory_id
          FROM memory_relations relation
          JOIN superseded ON relation.source_memory_id = superseded.memory_id
          WHERE relation.relation_type = 'SUPERSEDES'
        )
        SELECT 1 AS found FROM superseded WHERE memory_id = ? LIMIT 1
      `).get(targetMemoryId, sourceMemoryId) as { found: number } | undefined;
      if (cycle) throw new Error("A SUPERSEDES relation cannot create a cycle.");
    }
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        INSERT OR IGNORE INTO memory_relations(
          source_memory_id, target_memory_id, relation_type, reason, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(sourceMemoryId, targetMemoryId, type, reason.trim(), now);
      if (type === "SUPERSEDES" && target.lifecycleStatus === "ACTIVE") {
        this.#db.prepare("UPDATE memories SET lifecycle_status = 'SUPERSEDED', updated_at = ? WHERE id = ?")
          .run(now, targetMemoryId);
        this.#db.prepare(`
          INSERT INTO lifecycle_assessments(
            id, memory_id, previous_risk, new_risk, previous_lifecycle, new_lifecycle,
            relevance_milli, checked_commit, reason_codes_json, policy_version, assessor_version, assessed_at
          ) VALUES (?, ?, ?, ?, 'ACTIVE', 'SUPERSEDED', ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          targetMemoryId,
          target.correctnessRisk,
          target.correctnessRisk,
          target.relevance,
          source.commitSha ?? target.lastCheckedCommit ?? null,
          JSON.stringify(["EXPLICIT_SUPERSEDES"]),
          POLICY_VERSION,
          ASSESSOR_VERSION,
          now,
        );
        this.#appendRevision(target, `superseded-by:${sourceMemoryId}:${reason.trim()}`, "HUMAN_CLI", now);
      } else if (type === "CONTRADICTS") {
        this.#db.prepare(`
          UPDATE memories SET verification_state = 'DISPUTED', updated_at = ?
          WHERE project_id = ? AND id IN (?, ?)
        `).run(now, projectId, sourceMemoryId, targetMemoryId);
        this.#appendRevision(source, `contradicts:${targetMemoryId}:${reason.trim()}`, "HUMAN_CLI", now);
        this.#appendRevision(target, `contradicts:${sourceMemoryId}:${reason.trim()}`, "HUMAN_CLI", now);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  noteContextUsage(projectId: string, candidateIds: string[], selectedIds: string[], now: string): void {
    const candidates = [...new Set(candidateIds)].slice(0, 50);
    const selected = [...new Set(selectedIds)].filter((id) => candidates.includes(id)).slice(0, 50);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const candidateStatement = this.#db.prepare(`
        UPDATE memory_usage_stats SET candidate_count = candidate_count + 1, last_candidate_at = ?
        WHERE memory_id = ? AND EXISTS (SELECT 1 FROM memories WHERE id = ? AND project_id = ?)
      `);
      for (const id of candidates) candidateStatement.run(now, id, id, projectId);
      const selectedStatement = this.#db.prepare(`
        UPDATE memory_usage_stats SET selected_count = selected_count + 1, last_selected_at = ?
        WHERE memory_id = ? AND EXISTS (SELECT 1 FROM memories WHERE id = ? AND project_id = ?)
      `);
      for (const id of selected) selectedStatement.run(now, id, id, projectId);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  noteFeedback(projectId: string, memoryId: string, useful: boolean, reason: string): Memory {
    this.#validateReason(reason, "Feedback");
    const memory = this.get(projectId, memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    const now = new Date().toISOString();
    const column = useful ? "positive_feedback_count" : "negative_feedback_count";
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`UPDATE memory_usage_stats SET ${column} = ${column} + 1, last_feedback_at = ? WHERE memory_id = ?`)
        .run(now, memoryId);
      this.#appendRevision(memory, `feedback:${useful ? "USEFUL" : "NOT_USEFUL"}:${reason.trim()}`, "HUMAN_CLI", now);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    const updated = this.get(projectId, memoryId);
    if (!updated) throw new Error(`Memory not found after feedback: ${memoryId}`);
    return updated;
  }

  maintenanceCursor(projectId: string): string | undefined {
    const row = this.#db.prepare("SELECT checked_commit FROM maintenance_cursors WHERE project_id = ?")
      .get(projectId) as { checked_commit: string | null } | undefined;
    return row?.checked_commit ?? undefined;
  }

  maintenanceCandidates(
    projectId: string,
    limit: number,
    targetCommit?: string,
    archiveBefore?: string,
    now?: string,
    changedPaths: string[] = [],
  ): Memory[] {
    const paths = [...new Set(changedPaths)].slice(0, 1_000);
    const changedAnchorClause = paths.length > 0
      ? ` OR EXISTS (
          SELECT 1 FROM memory_anchors a
          WHERE a.memory_id = memories.id AND a.repo_relative_path IN (${paths.map(() => "?").join(",")})
        )`
      : "";
    const rows = this.#db.prepare(`
      SELECT * FROM memories WHERE project_id = ? AND lifecycle_status = 'ACTIVE'
        AND (? IS NULL OR coalesce(last_checked_commit, '') <> ?
          OR (completion_state <> 'OPEN' AND completed_at <= ?
            AND (restore_protected_until IS NULL OR restore_protected_until <= ?))
          OR correctness_risk = 'HIGH'
          OR EXISTS (
            SELECT 1 FROM memory_usage_stats u WHERE u.memory_id = memories.id
              AND (coalesce(u.last_candidate_at, '') > coalesce(memories.last_assessed_at, '')
                OR coalesce(u.last_selected_at, '') > coalesce(memories.last_assessed_at, '')
                OR coalesce(u.last_feedback_at, '') > coalesce(memories.last_assessed_at, ''))
          )${changedAnchorClause})
      ORDER BY coalesce(last_assessed_at, created_at), id LIMIT ?
    `).all(
      projectId,
      targetCommit ?? null,
      targetCommit ?? null,
      archiveBefore ?? "",
      now ?? "",
      ...paths,
      limit,
    ) as unknown as MemoryRow[];
    return rows.map((row) => this.#toMemory(row));
  }

  countExpiredRawEvents(projectId: string, now: string): number {
    const row = this.#db.prepare("SELECT count(*) AS count FROM raw_events WHERE project_id = ? AND expires_at <= ?")
      .get(projectId, now) as { count: number };
    return row.count;
  }

  applyMaintenance(
    projectId: string,
    actions: MaintenanceAction[],
    cursorCommit: string | undefined,
    now: string,
    policyVersion: string,
    assessorVersion: string,
  ): number {
    let rawEventsDeleted = 0;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const action of actions) {
        const memory = this.get(projectId, action.memoryId);
        if (!memory) continue;
        const stateChanged = memory.correctnessRisk !== action.newRisk
          || memory.lifecycleStatus !== action.newLifecycle
          || memory.relevance !== action.relevance
          || memory.lastCheckedCommit !== action.checkedCommit;
        if (!stateChanged) continue;
        this.#db.prepare(`
          UPDATE memories SET correctness_risk = ?, lifecycle_status = ?, relevance_milli = ?,
            last_checked_commit = ?, last_assessed_at = ?, updated_at = ?
          WHERE project_id = ? AND id = ?
        `).run(
          action.newRisk,
          action.newLifecycle,
          action.relevance,
          action.checkedCommit ?? null,
          now,
          now,
          projectId,
          action.memoryId,
        );
        if (memory.lifecycleStatus !== action.newLifecycle) {
          this.#appendRevision(memory, `maintenance:${action.reasonCodes.join(",")}`, "SYSTEM", now);
        }
        this.#db.prepare(`
          INSERT INTO lifecycle_assessments(
            id, memory_id, previous_risk, new_risk, previous_lifecycle, new_lifecycle,
            relevance_milli, checked_commit, reason_codes_json, policy_version, assessor_version, assessed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          action.memoryId,
          action.previousRisk,
          action.newRisk,
          action.previousLifecycle,
          action.newLifecycle,
          action.relevance,
          action.checkedCommit ?? null,
          JSON.stringify(action.reasonCodes),
          policyVersion,
          assessorVersion,
          now,
        );
      }
      rawEventsDeleted = Number(this.#db.prepare("DELETE FROM raw_events WHERE project_id = ? AND expires_at <= ?")
        .run(projectId, now).changes);
      this.#db.prepare(`
        INSERT INTO maintenance_cursors(project_id, checked_commit, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET checked_commit = excluded.checked_commit, updated_at = excluded.updated_at
      `).run(projectId, cursorCommit ?? null, now);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return rawEventsDeleted;
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
    const risk = this.#db.prepare(`
      SELECT
        sum(CASE WHEN correctness_risk = 'HIGH' AND lifecycle_status = 'ACTIVE' THEN 1 ELSE 0 END) AS high_risk,
        sum(CASE WHEN completion_state <> 'OPEN' AND lifecycle_status = 'ACTIVE' THEN 1 ELSE 0 END) AS completed
      FROM memories WHERE project_id = ?
    `).get(projectId) as { high_risk: number | null; completed: number | null };
    result.high_risk = risk.high_risk ?? 0;
    result.completed = risk.completed ?? 0;
    return result;
  }

  rebuildSearchIndex(): void {
    this.#db.exec("INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')");
  }

  backup(destination: string): Promise<number> {
    return backup(this.#db, destination);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#db.close(); } finally { this.#lease?.close(); }
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

  #migrateLifecycleColumns(): void {
    const columns = new Set((this.#db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>)
      .map((column) => column.name));
    const additions = [
      ["correctness_risk", "TEXT NOT NULL DEFAULT 'LOW' CHECK (correctness_risk IN ('LOW','MEDIUM','HIGH'))"],
      ["relevance_milli", "INTEGER NOT NULL DEFAULT 500 CHECK (relevance_milli BETWEEN 0 AND 1000)"],
      ["completion_state", "TEXT NOT NULL DEFAULT 'OPEN' CHECK (completion_state IN ('OPEN','COMPLETED','CANCELLED'))"],
      ["last_checked_commit", "TEXT"],
      ["last_assessed_at", "TEXT"],
      ["completed_at", "TEXT"],
      ["restore_protected_until", "TEXT"],
    ] as const;
    for (const [name, definition] of additions) {
      if (!columns.has(name)) this.#db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
    }
  }

  #migrateUsageColumns(): void {
    const columns = new Set((this.#db.prepare("PRAGMA table_info(memory_usage_stats)").all() as Array<{ name: string }>)
      .map((column) => column.name));
    if (!columns.has("last_feedback_at")) this.#db.exec("ALTER TABLE memory_usage_stats ADD COLUMN last_feedback_at TEXT");
  }

  #toMemory(row: MemoryRow): Memory {
    const files = this.#db.prepare("SELECT repo_relative_path FROM memory_files WHERE memory_id = ? ORDER BY repo_relative_path")
      .all(row.id) as Array<{ repo_relative_path: string }>;
    const anchors = this.#db.prepare(`
      SELECT repo_relative_path, content_digest, captured_commit
      FROM memory_anchors WHERE memory_id = ? ORDER BY repo_relative_path
    `).all(row.id) as Array<{ repo_relative_path: string; content_digest: string | null; captured_commit: string | null }>;
    const relations = this.#db.prepare(`
      SELECT source_memory_id, target_memory_id, relation_type, reason, created_at
      FROM memory_relations WHERE source_memory_id = ? OR target_memory_id = ?
      ORDER BY created_at, source_memory_id, target_memory_id
    `).all(row.id, row.id) as Array<{
      source_memory_id: string;
      target_memory_id: string;
      relation_type: string;
      reason: string;
      created_at: string;
    }>;
    const usage = this.#db.prepare("SELECT * FROM memory_usage_stats WHERE memory_id = ?").get(row.id) as {
      candidate_count: number;
      selected_count: number;
      positive_feedback_count: number;
      negative_feedback_count: number;
      last_candidate_at: string | null;
      last_selected_at: string | null;
      last_feedback_at: string | null;
    } | undefined;
    const assessment = this.#db.prepare(`
      SELECT * FROM lifecycle_assessments WHERE memory_id = ?
      ORDER BY assessed_at DESC, id DESC LIMIT 1
    `).get(row.id) as Record<string, string | number | null> | undefined;
    const revision = this.#db.prepare("SELECT count(*) AS count FROM memory_revisions WHERE memory_id = ?")
      .get(row.id) as { count: number };
    return {
      id: row.id,
      projectId: row.project_id,
      type: row.type as MemoryType,
      summary: row.summary,
      content: row.content,
      lifecycleStatus: row.lifecycle_status as Memory["lifecycleStatus"],
      verificationState: row.verification_state as Memory["verificationState"],
      correctnessRisk: (row.correctness_risk ?? "LOW") as CorrectnessRisk,
      relevance: row.relevance_milli ?? row.importance_milli,
      completionState: (row.completion_state ?? "OPEN") as CompletionState,
      confidence: row.confidence_milli,
      importance: row.importance_milli,
      sourceType: row.source_type as Memory["sourceType"],
      ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
      ...(row.branch_name ? { branchName: row.branch_name } : {}),
      files: files.map((file) => file.repo_relative_path),
      fileAnchors: anchors.map((anchor) => ({
        path: anchor.repo_relative_path,
        ...(anchor.content_digest ? { contentDigest: anchor.content_digest } : {}),
        ...(anchor.captured_commit ? { capturedCommit: anchor.captured_commit } : {}),
      })),
      relations: relations.map((relation) => ({
        sourceMemoryId: relation.source_memory_id,
        targetMemoryId: relation.target_memory_id,
        type: relation.relation_type as MemoryRelationType,
        reason: relation.reason,
        createdAt: relation.created_at,
      })),
      usage: {
        candidateCount: usage?.candidate_count ?? 0,
        selectedCount: usage?.selected_count ?? 0,
        positiveFeedbackCount: usage?.positive_feedback_count ?? 0,
        negativeFeedbackCount: usage?.negative_feedback_count ?? 0,
        ...(usage?.last_candidate_at ? { lastCandidateAt: usage.last_candidate_at } : {}),
        ...(usage?.last_selected_at ? { lastSelectedAt: usage.last_selected_at } : {}),
        ...(usage?.last_feedback_at ? { lastFeedbackAt: usage.last_feedback_at } : {}),
      },
      revisionCount: revision.count,
      ...(assessment ? {
        latestAssessment: {
          previousRisk: String(assessment.previous_risk) as CorrectnessRisk,
          newRisk: String(assessment.new_risk) as CorrectnessRisk,
          previousLifecycle: String(assessment.previous_lifecycle) as Memory["lifecycleStatus"],
          newLifecycle: String(assessment.new_lifecycle) as Memory["lifecycleStatus"],
          relevance: Number(assessment.relevance_milli),
          ...(assessment.checked_commit ? { checkedCommit: String(assessment.checked_commit) } : {}),
          reasonCodes: JSON.parse(String(assessment.reason_codes_json)) as string[],
          policyVersion: String(assessment.policy_version),
          assessorVersion: String(assessment.assessor_version),
          assessedAt: String(assessment.assessed_at),
        },
      } : {}),
      ...(row.last_checked_commit ? { lastCheckedCommit: row.last_checked_commit } : {}),
      ...(row.last_assessed_at ? { lastAssessedAt: row.last_assessed_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.restore_protected_until ? { restoreProtectedUntil: row.restore_protected_until } : {}),
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
