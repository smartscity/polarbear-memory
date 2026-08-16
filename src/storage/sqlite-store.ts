import { createHash, randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import type { Memory, MemorySearchResult, MemoryType, RecordMemoryInput } from "../domain/memory.js";
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
  source_type TEXT NOT NULL CHECK (source_type IN ('CLI','FIXTURE')),
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

  constructor(databasePath: string) {
    this.#db = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: 2_000,
    });
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000; PRAGMA trusted_schema = OFF;");
    this.#db.exec(SCHEMA);
    this.#db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
  }

  initializeProject(project: { id: string; name: string }): void {
    const now = new Date().toISOString();
    this.#db.prepare(`
      INSERT INTO projects(id, display_name, created_at, last_seen_at, schema_version)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, last_seen_at = excluded.last_seen_at
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
        this.#db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(now, duplicate.id);
        this.#db.exec("COMMIT");
        const existing = this.get(projectId, duplicate.id);
        if (!existing) throw new Error("Memory disappeared after deduplication.");
        return existing;
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
}
