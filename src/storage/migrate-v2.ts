import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { V2_MIGRATION_CHECKSUM, V2_SCHEMA } from "./schema-v2.js";

const LEGACY_TABLES = [
  "memory_files",
  "memory_revisions",
  "memory_anchors",
  "memory_relations",
  "memory_usage_stats",
  "context_token_savings",
  "lifecycle_assessments",
  "maintenance_cursors",
  "raw_events",
  "purge_audit",
  "memories",
  "projects",
] as const;

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));
}

function registerDigest(db: DatabaseSync): void {
  db.function("polarbear_sha256", { deterministic: true }, (value: unknown) => createHash("sha256").update(String(value)).digest("hex"));
}

function copyOptionalTable(db: DatabaseSync, name: string, sql: string): void {
  if (tableExists(db, `legacy_${name}_v1`)) db.exec(sql);
}

export function migrateLegacyToV2(db: DatabaseSync, appliedAt: string): void {
  if (!tableExists(db, "memories")) return;
  registerDigest(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_au;
      DROP TABLE IF EXISTS memory_fts;
    `);
    for (const table of LEGACY_TABLES) {
      if (tableExists(db, table)) db.exec(`ALTER TABLE ${table} RENAME TO legacy_${table}_v1`);
    }

    const migrationColumns = new Set((db.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!migrationColumns.has("checksum")) db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
    db.exec(V2_SCHEMA);
    db.prepare("INSERT INTO workspaces(id, name, created_at, updated_at) VALUES ('local', 'Local', ?, ?)")
      .run(appliedAt, appliedAt);

    if (!tableExists(db, "legacy_projects_v1")) throw new Error("Legacy projects table is missing.");
    db.exec(`
      INSERT INTO projects(id, workspace_id, display_name, identity_kind, identity_value, created_at, last_seen_at, schema_version)
      SELECT id, 'local', display_name, 'LOCAL_CONFIG', id, created_at, last_seen_at, 7
      FROM legacy_projects_v1;

      INSERT INTO knowledge_units(
        id, workspace_id, project_id, kind, summary, body, lifecycle_status,
        verification_state, correctness_risk, confidence_milli, importance_milli,
        relevance_milli, completion_state, valid_from, current_content_hash,
        created_at, updated_at, extractor_version, last_checked_commit,
        last_assessed_at, completed_at, restore_protected_until, archived_at
      )
      SELECT id, 'local', project_id, type, summary, content, lifecycle_status,
        verification_state, correctness_risk, confidence_milli, importance_milli,
        relevance_milli, completion_state, created_at, content_hash,
        created_at, updated_at, 'migration-v1', last_checked_commit,
        last_assessed_at, completed_at, restore_protected_until,
        CASE WHEN lifecycle_status = 'ARCHIVED' THEN updated_at ELSE NULL END
      FROM legacy_memories_v1;

      INSERT INTO episodes(
        id, project_id, episode_type, occurred_at, ingested_at, source_digest,
        summary, retention_class, created_at
      )
      SELECT 'migration-episode-' || id, project_id,
        CASE WHEN source_type = 'CLI' AND type = 'DECISION' THEN 'USER_DECISION' ELSE 'TOOL_RESULT' END,
        created_at, created_at, content_hash, summary,
        CASE WHEN type IN ('TASK_STATE','TODO') THEN 'SHORT' ELSE 'DURABLE' END,
        created_at
      FROM legacy_memories_v1;

      INSERT INTO evidence(
        id, project_id, episode_id, evidence_type, source_ref, digest,
        observed_at, commit_sha, trust_level, metadata_json, created_at
      )
      SELECT 'migration-evidence-' || id, project_id, 'migration-episode-' || id,
        CASE source_type WHEN 'CLI' THEN 'USER_STATEMENT' WHEN 'MCP' THEN 'AGENT_RESULT'
          WHEN 'HOOK' THEN 'AGENT_RESULT' ELSE 'OTHER' END,
        CASE WHEN commit_sha IS NULL THEN source_type ELSE 'git:' || commit_sha END,
        content_hash, created_at, commit_sha,
        CASE source_type WHEN 'CLI' THEN 'HIGH' WHEN 'FIXTURE' THEN 'LOW' ELSE 'MEDIUM' END,
        json_object('legacySourceType', source_type, 'branchName', branch_name), created_at
      FROM legacy_memories_v1;

      INSERT INTO knowledge_evidence(knowledge_id, evidence_id, role, confidence_milli, created_at)
      SELECT id, 'migration-evidence-' || id, 'ORIGIN', confidence_milli, created_at
      FROM legacy_memories_v1;
    `);

    copyOptionalTable(db, "memory_revisions", `
      INSERT INTO knowledge_versions(
        id, knowledge_id, version_no, summary, body, content_hash, valid_from,
        created_at, actor_kind, reason
      )
      SELECT id, memory_id, revision_no, summary, content,
        polarbear_sha256(summary || char(0) || content), created_at,
        created_at, actor_kind, reason
      FROM legacy_memory_revisions_v1;
    `);
    db.exec(`
      INSERT INTO knowledge_versions(
        id, knowledge_id, version_no, summary, body, content_hash, valid_from,
        created_at, actor_kind, reason
      )
      SELECT 'migration-current-' || k.id, k.id,
        coalesce((SELECT max(version_no) + 1 FROM knowledge_versions v WHERE v.knowledge_id = k.id), 1),
        k.summary, k.body, k.current_content_hash, k.valid_from, k.updated_at, 'SYSTEM', 'migration-current-snapshot'
      FROM knowledge_units k
      WHERE NOT EXISTS (
        SELECT 1 FROM knowledge_versions v
        WHERE v.knowledge_id = k.id AND v.summary = k.summary AND v.body = k.body
      );
    `);

    copyOptionalTable(db, "memory_files", `
      INSERT OR IGNORE INTO entities(id, project_id, kind, canonical_key, display_name, created_at, updated_at)
      SELECT 'migration-file-' || polarbear_sha256(m.project_id || char(0) || f.repo_relative_path),
        m.project_id, 'FILE', 'file://' || f.repo_relative_path, f.repo_relative_path, m.created_at, m.updated_at
      FROM legacy_memory_files_v1 f
      JOIN legacy_memories_v1 m ON m.id = f.memory_id;

      INSERT OR IGNORE INTO knowledge_entities(knowledge_id, entity_id, role, confidence_milli, created_at)
      SELECT f.memory_id, e.id, 'REFERENCES', 1000, m.created_at
      FROM legacy_memory_files_v1 f
      JOIN legacy_memories_v1 m ON m.id = f.memory_id
      JOIN entities e ON e.project_id = m.project_id AND e.canonical_key = 'file://' || f.repo_relative_path;
    `);

    copyOptionalTable(db, "memory_anchors", `
      INSERT OR IGNORE INTO entities(id, project_id, kind, canonical_key, display_name, created_at, updated_at)
      SELECT 'migration-file-' || polarbear_sha256(m.project_id || char(0) || a.repo_relative_path),
        m.project_id, 'FILE', 'file://' || a.repo_relative_path, a.repo_relative_path, m.created_at, m.updated_at
      FROM legacy_memory_anchors_v1 a
      JOIN legacy_memories_v1 m ON m.id = a.memory_id;

      INSERT INTO knowledge_anchors(
        id, knowledge_id, entity_id, repo_relative_path, content_digest,
        captured_commit, created_at, updated_at
      )
      SELECT 'migration-anchor-' || polarbear_sha256(a.memory_id || char(0) || a.repo_relative_path),
        a.memory_id, e.id, a.repo_relative_path, a.content_digest,
        a.captured_commit, m.created_at, m.updated_at
      FROM legacy_memory_anchors_v1 a
      JOIN legacy_memories_v1 m ON m.id = a.memory_id
      JOIN entities e ON e.project_id = m.project_id AND e.canonical_key = 'file://' || a.repo_relative_path;

      INSERT OR IGNORE INTO knowledge_entities(knowledge_id, entity_id, role, confidence_milli, created_at)
      SELECT a.memory_id, e.id, 'REFERENCES', 1000, m.created_at
      FROM legacy_memory_anchors_v1 a
      JOIN legacy_memories_v1 m ON m.id = a.memory_id
      JOIN entities e ON e.project_id = m.project_id AND e.canonical_key = 'file://' || a.repo_relative_path;
    `);

    copyOptionalTable(db, "memory_relations", `
      INSERT INTO knowledge_relations(
        id, from_knowledge_id, to_knowledge_id, relation_type,
        confidence_milli, reason, created_at, valid_from
      )
      SELECT 'migration-relation-' || polarbear_sha256(source_memory_id || char(0) || target_memory_id || char(0) || relation_type),
        source_memory_id, target_memory_id, relation_type, 1000, reason, created_at, created_at
      FROM legacy_memory_relations_v1;

      UPDATE knowledge_units SET
        lifecycle_status = 'SUPERSEDED',
        valid_to = coalesce(valid_to, (
          SELECT min(created_at) FROM knowledge_relations r
          WHERE r.to_knowledge_id = knowledge_units.id AND r.relation_type = 'SUPERSEDES'
        ))
      WHERE id IN (
        SELECT to_knowledge_id FROM knowledge_relations WHERE relation_type = 'SUPERSEDES'
      );
    `);

    copyOptionalTable(db, "memory_usage_stats", `
      INSERT INTO knowledge_usage_stats(
        knowledge_id, candidate_count, selected_count, positive_feedback_count,
        negative_feedback_count, last_candidate_at, last_selected_at, last_feedback_at
      )
      SELECT memory_id, candidate_count, selected_count, positive_feedback_count,
        negative_feedback_count, last_candidate_at, last_selected_at, last_feedback_at
      FROM legacy_memory_usage_stats_v1;
    `);
    db.exec("INSERT OR IGNORE INTO knowledge_usage_stats(knowledge_id) SELECT id FROM knowledge_units");

    copyOptionalTable(db, "lifecycle_assessments", `
      INSERT INTO lifecycle_assessments(
        id, knowledge_id, previous_risk, new_risk, previous_lifecycle, new_lifecycle,
        relevance_milli, checked_commit, reason_codes_json, policy_version, assessor_version, assessed_at
      )
      SELECT id, memory_id, previous_risk, new_risk, previous_lifecycle, new_lifecycle,
        relevance_milli, checked_commit, reason_codes_json, policy_version, assessor_version, assessed_at
      FROM legacy_lifecycle_assessments_v1;
    `);

    copyOptionalTable(db, "context_token_savings", `
      INSERT INTO context_token_savings SELECT * FROM legacy_context_token_savings_v1;
    `);
    copyOptionalTable(db, "maintenance_cursors", `
      INSERT INTO maintenance_cursors SELECT * FROM legacy_maintenance_cursors_v1;
    `);
    copyOptionalTable(db, "raw_events", `
      INSERT INTO raw_events SELECT * FROM legacy_raw_events_v1;
    `);
    copyOptionalTable(db, "purge_audit", `
      INSERT INTO purge_audit SELECT * FROM legacy_purge_audit_v1;
    `);

    const legacyCount = (db.prepare("SELECT count(*) AS count FROM legacy_memories_v1").get() as { count: number }).count;
    const migratedCount = (db.prepare("SELECT count(*) AS count FROM knowledge_units").get() as { count: number }).count;
    if (legacyCount !== migratedCount) throw new Error(`Knowledge migration count mismatch: ${legacyCount} != ${migratedCount}`);
    const versionless = (db.prepare(`
      SELECT count(*) AS count FROM knowledge_units k
      WHERE NOT EXISTS (SELECT 1 FROM knowledge_versions v WHERE v.knowledge_id = k.id)
    `).get() as { count: number }).count;
    if (versionless !== 0) throw new Error("Knowledge migration left units without a version.");
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) throw new Error("V2 migration produced foreign-key violations.");
    db.prepare("INSERT OR REPLACE INTO schema_migrations(version, applied_at, checksum) VALUES (7, ?, ?)")
      .run(appliedAt, V2_MIGRATION_CHECKSUM);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may not have started */ }
    throw error;
  }
}
