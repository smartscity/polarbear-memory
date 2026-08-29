import type { DatabaseSync } from "node:sqlite";

const LEGACY_SCHEMA = `
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

CREATE TABLE IF NOT EXISTS context_token_savings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  context_pack_count INTEGER NOT NULL DEFAULT 0 CHECK (context_pack_count >= 0),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  selected_count INTEGER NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
  baseline_tokens INTEGER NOT NULL DEFAULT 0 CHECK (baseline_tokens >= 0),
  context_tokens INTEGER NOT NULL DEFAULT 0 CHECK (context_tokens >= 0),
  estimated_saved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (estimated_saved_tokens >= 0),
  measurement_started_at TEXT NOT NULL,
  last_context_at TEXT,
  reset_count INTEGER NOT NULL DEFAULT 0 CHECK (reset_count >= 0)
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

/** Isolates one-time compatibility work from the V2 runtime repositories. */
export class LegacyV1SchemaManager {
  readonly #db: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#db = database;
  }

  prepare(): void {
    this.#db.exec(LEGACY_SCHEMA);
    this.#migrateMemorySourceTypes();
    this.#migrateLifecycleColumns();
    this.#migrateUsageColumns();
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

}

