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
import { isSessionEndEvent, sessionAgentKind, type EventEnvelope, type StoredRawEvent } from "../domain/event.js";
import { validateRecordInput } from "../domain/memory.js";
import type {
  Entity,
  EntityKind,
  EntityRole,
  Episode,
  Evidence,
  EvidenceRole,
  Session,
} from "../domain/knowledge.js";
import type { MemoryStore, TokenSavingsStats } from "../application/ports.js";
import type { ContextOsPort } from "../domain/context-os.js";
import { acquireClientLease, type ClientLease } from "./client-lease.js";
import { migrateLegacyToV2 } from "./migrate-v2.js";
import {
  CONTEXT_OS_MIGRATION_CHECKSUM, CURRENT_SCHEMA_VERSION, V2_MIGRATION_CHECKSUM, V2_SCHEMA,
} from "./schema-v2.js";
import { KnowledgeSearchIndex } from "./knowledge-index.js";
import { recordLifecycleAssessment } from "./lifecycle-assessments.js";
import { inImmediateTransaction } from "./sqlite-transaction.js";
import { hydrateMemories, type MemoryProjectionRow as MemoryRow } from "./memory-read-model.js";
import { KnowledgeQueryService } from "./knowledge-query-service.js";
import { LegacyV1SchemaManager } from "./legacy-v1-schema.js";
import {
  CaptureService,
  type EndSessionInput,
  type EntityInput,
  type EpisodeInput,
  type EvidenceInput,
  type SessionInput,
} from "./capture-service.js";
import { KnowledgeRepository, validateReason } from "./knowledge-repository.js";
import { UsageService } from "./usage-service.js";
import { KnowledgeCommandService } from "./knowledge-command-service.js";
import { LifecycleService } from "./lifecycle-service.js";
import { RawEventService } from "./raw-event-service.js";
import { createContextOs } from "./context-os-factory.js";

export { CURRENT_SCHEMA_VERSION } from "./schema-v2.js";

function quoteSqliteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function existingSchemaVersion(db: DatabaseSync): { hasData: boolean; version: number } {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('memories', 'knowledge_units', 'schema_migrations')").all() as Array<{ name: string }>;
  const hasData = tables.some((row) => row.name === "memories" || row.name === "knowledge_units");
  if (!tables.some((row) => row.name === "schema_migrations")) return { hasData, version: 0 };
  const row = db.prepare("SELECT coalesce(max(version), 0) AS version FROM schema_migrations").get() as { version: number };
  return { hasData, version: row.version };
}

export class SqliteMemoryStore implements MemoryStore {
  readonly #db!: DatabaseSync;
  readonly #searchIndex!: KnowledgeSearchIndex;
  readonly #queries!: KnowledgeQueryService;
  readonly #capture!: CaptureService;
  readonly #knowledge!: KnowledgeRepository;
  readonly #usage!: UsageService;
  readonly #commands!: KnowledgeCommandService;
  readonly #lifecycle!: LifecycleService;
  readonly #rawEvents!: RawEventService;
  readonly #contextOs!: ContextOsPort;
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
      this.#searchIndex = new KnowledgeSearchIndex(this.#db);
      this.#queries = new KnowledgeQueryService(this.#db);
      this.#capture = new CaptureService(this.#db, this.#searchIndex);
      this.#knowledge = new KnowledgeRepository(this.#db, this.#searchIndex);
      this.#usage = new UsageService(this.#db, this.#knowledge);
      this.#commands = new KnowledgeCommandService(this.#db, this.#knowledge, this.#capture);
      this.#lifecycle = new LifecycleService(this.#db, this.#knowledge);
      this.#rawEvents = new RawEventService(this.#db, this.#capture);
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
        const migrationTime = new Date().toISOString();
        const hasLegacyMemory = Boolean(this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memories'").get());
        if (hasLegacyMemory) {
          new LegacyV1SchemaManager(this.#db).prepare();
          this.#db.exec(`
            CREATE INDEX IF NOT EXISTS memories_maintenance
              ON memories(project_id, lifecycle_status, last_checked_commit, completed_at);
            INSERT OR IGNORE INTO memory_revisions(
              id, memory_id, revision_no, content, summary, reason, actor_kind, created_at
            )
            SELECT 'migration-v2-' || id, id, 1, content, summary, 'migrated', 'SYSTEM', created_at
            FROM memories;
            INSERT OR IGNORE INTO memory_usage_stats(memory_id) SELECT id FROM memories;
            INSERT OR IGNORE INTO memory_anchors(memory_id, repo_relative_path)
              SELECT memory_id, repo_relative_path FROM memory_files;
          `);
          migrateLegacyToV2(this.#db, migrationTime);
        } else if (existing.version < 7) {
          inImmediateTransaction(this.#db, () => {
            this.#db.exec(V2_SCHEMA);
            for (let version = 1; version < CURRENT_SCHEMA_VERSION; version += 1) {
              this.#db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at, checksum) VALUES (?, ?, ?)")
                .run(version, migrationTime, version === 7 ? V2_MIGRATION_CHECKSUM : `legacy-v${version}`);
            }
          });
        }
        if (existing.version < CURRENT_SCHEMA_VERSION) {
          inImmediateTransaction(this.#db, () => {
            this.#db.exec("DROP VIEW IF EXISTS memory_projection");
            this.#db.exec(V2_SCHEMA);
            const violations = this.#db.prepare("PRAGMA foreign_key_check").all();
            if (violations.length > 0) throw new Error("Context OS migration produced foreign-key violations.");
            this.#db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at, checksum) VALUES (?, ?, ?)")
              .run(CURRENT_SCHEMA_VERSION, migrationTime, CONTEXT_OS_MIGRATION_CHECKSUM);
          });
        } else {
          this.#db.exec(V2_SCHEMA);
        }
        this.#contextOs = createContextOs(this.#db, {
            search: (projectId, query, limit) => this.#queries.search(projectId, query, limit),
            recent: (projectId, limit) => this.#queries.recent(projectId, limit),
            record: (projectId, input) => this.#commands.record(projectId, input),
        });
        this.#searchIndex.rebuild();
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
      INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('local', 'Local', ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
    `).run(now, now);
    this.#db.prepare(`
      INSERT INTO projects(id, workspace_id, display_name, identity_kind, identity_value, created_at, last_seen_at, schema_version)
      VALUES (?, 'local', ?, 'LOCAL_CONFIG', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
        last_seen_at = excluded.last_seen_at, schema_version = excluded.schema_version
    `).run(project.id, project.name, project.id, now, now, CURRENT_SCHEMA_VERSION);
    this.#db.prepare(`
      INSERT OR IGNORE INTO context_token_savings(project_id, measurement_started_at)
      VALUES (?, ?)
    `).run(project.id, now);
  }

  upsertSession(projectId: string, input: SessionInput): Session {
    return this.#capture.upsertSession(projectId, input);
  }

  endSession(projectId: string, sessionId: string, input: EndSessionInput): Session {
    return this.#capture.endSession(projectId, sessionId, input);
  }

  recordEpisode(projectId: string, input: EpisodeInput): Episode {
    return this.#capture.recordEpisode(projectId, input);
  }

  recordEvidence(projectId: string, input: EvidenceInput): Evidence {
    return this.#capture.recordEvidence(projectId, input);
  }

  linkEvidence(projectId: string, memoryId: string, evidenceId: string, role: EvidenceRole, confidence = 700): Memory {
    return this.#capture.linkEvidence(projectId, memoryId, evidenceId, role, confidence);
  }

  upsertEntity(projectId: string, input: EntityInput): Entity {
    return this.#capture.upsertEntity(projectId, input);
  }

  linkEntity(projectId: string, memoryId: string, entityId: string, role: EntityRole, confidence = 700): Memory {
    return this.#capture.linkEntity(projectId, memoryId, entityId, role, confidence);
  }

  record(projectId: string, input: RecordMemoryInput): Memory {
    return this.#commands.record(projectId, input);
  }

  get(projectId: string, memoryId: string): Memory | undefined {
    return this.#commands.get(projectId, memoryId);
  }

  update(projectId: string, memoryId: string, input: { summary: string; content: string; reason: string }): Memory {
    return this.#commands.update(projectId, memoryId, input);
  }

  purge(projectId: string, memoryId: string, reason: string): { purgedMemoryIdHash: string } {
    return this.#commands.purge(projectId, memoryId, reason);
  }

  revisions(projectId: string, memoryId: string): MemoryRevision[] {
    return this.#commands.revisions(projectId, memoryId);
  }

  search(projectId: string, query: string, limit: number): MemorySearchResult[] {
    return this.#queries.search(projectId, query, limit);
  }

  recent(projectId: string, limit: number): MemorySearchResult[] {
    return this.#queries.recent(projectId, limit);
  }

  list(
    projectId: string,
    options: { query?: string; status?: Memory["lifecycleStatus"]; type?: MemoryType; limit: number; offset: number },
  ): Memory[] {
    return this.#queries.list(projectId, options);
  }

  verify(
    projectId: string,
    memoryId: string,
    state: VerificationState,
    reason: string,
    actor: "HUMAN_CLI" | "AGENT_MCP" = "AGENT_MCP",
    evidence: { anchors?: FileAnchor[]; checkedCommit?: string } = {},
  ): Memory {
    return this.#lifecycle.verify(projectId, memoryId, state, reason, actor, evidence);
  }

  archive(projectId: string, memoryId: string, reason: string, actor: "HUMAN_CLI" | "AGENT_MCP" = "AGENT_MCP"): Memory {
    return this.#lifecycle.archive(projectId, memoryId, reason, actor);
  }

  restore(projectId: string, memoryId: string, reason: string): Memory {
    return this.#lifecycle.restore(projectId, memoryId, reason);
  }

  complete(projectId: string, memoryId: string, state: Exclude<CompletionState, "OPEN">, reason: string, clock = new Date()): Memory {
    return this.#lifecycle.complete(projectId, memoryId, state, reason, clock);
  }

  addRelation(projectId: string, sourceMemoryId: string, targetMemoryId: string, type: MemoryRelationType, reason: string): void {
    this.#commands.addRelation(projectId, sourceMemoryId, targetMemoryId, type, reason);
  }

  noteContextUsage(
    projectId: string,
    candidateIds: string[],
    selectedIds: string[],
    tokens: { baseline: number; context: number },
    now: string,
  ): void {
    this.#usage.noteContextUsage(projectId, candidateIds, selectedIds, tokens, now);
  }

  tokenSavings(projectId: string): TokenSavingsStats {
    return this.#usage.tokenSavings(projectId);
  }

  resetTokenSavings(projectId: string, now: string): TokenSavingsStats {
    return this.#usage.resetTokenSavings(projectId, now);
  }

  contextOs(): ContextOsPort {
    return this.#contextOs;
  }

  noteFeedback(projectId: string, memoryId: string, useful: boolean, reason: string): Memory {
    return this.#usage.noteFeedback(projectId, memoryId, useful, reason);
  }

  maintenanceCursor(projectId: string): string | undefined {
    return this.#lifecycle.maintenanceCursor(projectId);
  }

  maintenanceCandidates(
    projectId: string,
    limit: number,
    targetCommit?: string,
    archiveBefore?: string,
    now?: string,
    changedPaths: string[] = [],
  ): Memory[] {
    return this.#lifecycle.maintenanceCandidates(projectId, limit, targetCommit, archiveBefore, now, changedPaths);
  }

  countExpiredRawEvents(projectId: string, now: string): number {
    return this.#lifecycle.countExpiredRawEvents(projectId, now);
  }

  applyMaintenance(
    projectId: string,
    actions: MaintenanceAction[],
    cursorCommit: string | undefined,
    now: string,
    policyVersion: string,
    assessorVersion: string,
  ): number {
    return this.#lifecycle.applyMaintenance(projectId, actions, cursorCommit, now, policyVersion, assessorVersion);
  }

  ingestRawEvent(event: EventEnvelope): boolean {
    return this.#rawEvents.ingest(event);
  }

  unprocessedRawEvents(projectId: string, sessionRefHash: string): StoredRawEvent[] {
    return this.#rawEvents.unprocessed(projectId, sessionRefHash);
  }

  pendingEndedSessions(projectId: string): string[] {
    return this.#rawEvents.pendingEndedSessions(projectId);
  }

  markRawEventProcessed(projectId: string, eventId: string, processedAt: string): void {
    this.#rawEvents.markProcessed(projectId, eventId, processedAt);
  }

  deleteExpiredRawEvents(projectId: string, now: string): number {
    return this.#rawEvents.deleteExpired(projectId, now);
  }

  status(projectId: string): Record<string, number> {
    const result: Record<string, number> = { total: 0 };
    let total = 0;
    const rows = this.#db.prepare(`
      SELECT lifecycle_status AS status, count(*) AS count
      FROM knowledge_units WHERE project_id = ? GROUP BY lifecycle_status
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
      FROM knowledge_units WHERE project_id = ?
    `).get(projectId) as { high_risk: number | null; completed: number | null };
    result.high_risk = risk.high_risk ?? 0;
    result.completed = risk.completed ?? 0;
    return result;
  }

  rebuildSearchIndex(): void {
    this.#searchIndex.rebuild(true);
  }

  backup(destination: string): Promise<number> {
    return backup(this.#db, destination);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#db.close(); } finally { this.#lease?.close(); }
  }

}
