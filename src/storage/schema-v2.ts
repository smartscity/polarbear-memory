export const CURRENT_SCHEMA_VERSION = 7;
export const V2_MIGRATION_CHECKSUM = "v2-fact-episode-entity-2026-08-28";

export const V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  checksum TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  display_name TEXT NOT NULL,
  identity_kind TEXT NOT NULL DEFAULT 'LOCAL_CONFIG',
  identity_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS projects_workspace ON projects(workspace_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_kind TEXT NOT NULL CHECK (agent_kind IN ('CLAUDE','CURSOR','CODEX','OTHER')),
  external_session_ref_hash TEXT,
  branch_name TEXT,
  head_start TEXT,
  head_end TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  capture_status TEXT NOT NULL CHECK (capture_status IN ('OPEN','ENDED','PARTIAL','FAILED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, agent_kind, external_session_ref_hash)
) STRICT;

CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  episode_type TEXT NOT NULL CHECK (episode_type IN (
    'AGENT_SESSION_END','USER_DECISION','GIT_COMMIT','TEST_RESULT','CI_RESULT',
    'MR_MERGED','FILE_CHANGE','INCIDENT','TOOL_RESULT'
  )),
  occurred_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (length(summary) > 0),
  payload_ref TEXT,
  retention_class TEXT NOT NULL CHECK (retention_class IN ('TRANSIENT','SHORT','STANDARD','DURABLE')),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, source_digest, episode_type)
) STRICT;

CREATE INDEX IF NOT EXISTS episodes_project ON episodes(project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS episodes_session ON episodes(session_id, occurred_at);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN (
    'FILE_RANGE','SYMBOL','GIT_COMMIT','TEST','USER_STATEMENT','AGENT_RESULT',
    'ADR','ISSUE','MR','CI','OTHER'
  )),
  source_ref TEXT,
  digest TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  commit_sha TEXT,
  trust_level TEXT NOT NULL CHECK (trust_level IN ('LOW','MEDIUM','HIGH')),
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, digest, evidence_type, source_ref)
) STRICT;

CREATE INDEX IF NOT EXISTS evidence_project ON evidence(project_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS evidence_episode ON evidence(episode_id);
CREATE INDEX IF NOT EXISTS evidence_commit ON evidence(project_id, commit_sha) WHERE commit_sha IS NOT NULL;

CREATE TABLE IF NOT EXISTS knowledge_units (
  row_id INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'DECISION','PITFALL','FACT','CONSTRAINT','ARCHITECTURE','CONVENTION','TASK_STATE','TODO','WORKAROUND'
  )),
  summary TEXT NOT NULL CHECK (length(summary) > 0),
  body TEXT NOT NULL CHECK (length(body) > 0),
  scope_kind TEXT,
  scope_ref TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (lifecycle_status IN ('ACTIVE','ARCHIVED','SUPERSEDED','REJECTED')),
  verification_state TEXT NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (verification_state IN ('UNVERIFIED','VERIFIED','DISPUTED')),
  correctness_risk TEXT NOT NULL DEFAULT 'LOW'
    CHECK (correctness_risk IN ('LOW','MEDIUM','HIGH')),
  confidence_milli INTEGER NOT NULL CHECK (confidence_milli BETWEEN 0 AND 1000),
  importance_milli INTEGER NOT NULL CHECK (importance_milli BETWEEN 0 AND 1000),
  relevance_milli INTEGER NOT NULL DEFAULT 500 CHECK (relevance_milli BETWEEN 0 AND 1000),
  completion_state TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (completion_state IN ('OPEN','COMPLETED','CANCELLED')),
  valid_from TEXT,
  valid_to TEXT,
  current_content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  extractor_version TEXT,
  last_checked_commit TEXT,
  last_assessed_at TEXT,
  completed_at TEXT,
  restore_protected_until TEXT,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
) STRICT;

CREATE INDEX IF NOT EXISTS knowledge_project_status
  ON knowledge_units(project_id, lifecycle_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_workspace ON knowledge_units(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_kind ON knowledge_units(project_id, kind, lifecycle_status);
CREATE INDEX IF NOT EXISTS knowledge_temporal ON knowledge_units(project_id, valid_from, valid_to);
CREATE INDEX IF NOT EXISTS knowledge_maintenance
  ON knowledge_units(project_id, lifecycle_status, last_checked_commit, completed_at);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_project_content_hash
  ON knowledge_units(project_id, current_content_hash);

CREATE TABLE IF NOT EXISTS knowledge_versions (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  summary TEXT NOT NULL CHECK (length(summary) > 0),
  body TEXT NOT NULL CHECK (length(body) > 0),
  content_hash TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  created_at TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('HUMAN_CLI','AGENT_MCP','SYSTEM')),
  reason TEXT,
  UNIQUE(knowledge_id, version_no)
) STRICT;

CREATE INDEX IF NOT EXISTS knowledge_versions_identity ON knowledge_versions(knowledge_id, version_no DESC);

CREATE TABLE IF NOT EXISTS knowledge_evidence (
  knowledge_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('ORIGIN','SUPPORTS','VERIFIES','CONTRADICTS','INVALIDATES')),
  confidence_milli INTEGER NOT NULL CHECK (confidence_milli BETWEEN 0 AND 1000),
  created_at TEXT NOT NULL,
  PRIMARY KEY(knowledge_id, evidence_id, role)
) STRICT;

CREATE INDEX IF NOT EXISTS knowledge_evidence_by_evidence ON knowledge_evidence(evidence_id, knowledge_id);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('MODULE','FILE','SYMBOL','SERVICE','API','DATABASE_TABLE','DEPENDENCY','ISSUE','CONCEPT')),
  canonical_key TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(display_name) > 0),
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, canonical_key)
) STRICT;

CREATE INDEX IF NOT EXISTS entities_project_kind ON entities(project_id, kind, display_name);

CREATE TABLE IF NOT EXISTS knowledge_entities (
  knowledge_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('SUBJECT','AFFECTS','REFERENCES','DEPENDS_ON','RELATED')),
  confidence_milli INTEGER NOT NULL CHECK (confidence_milli BETWEEN 0 AND 1000),
  created_at TEXT NOT NULL,
  PRIMARY KEY(knowledge_id, entity_id, role)
) STRICT;

CREATE INDEX IF NOT EXISTS knowledge_entities_by_entity ON knowledge_entities(entity_id, knowledge_id);

CREATE TABLE IF NOT EXISTS knowledge_relations (
  id TEXT PRIMARY KEY,
  from_knowledge_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
  to_knowledge_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('SUPERSEDES','CONTRADICTS','EXTENDS','DERIVES','DEPENDS_ON','RELATED_TO')),
  valid_from TEXT,
  valid_to TEXT,
  confidence_milli INTEGER NOT NULL CHECK (confidence_milli BETWEEN 0 AND 1000),
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(from_knowledge_id, to_knowledge_id, relation_type),
  CHECK (from_knowledge_id <> to_knowledge_id)
) STRICT;

CREATE INDEX IF NOT EXISTS knowledge_relations_from ON knowledge_relations(from_knowledge_id, relation_type);
CREATE INDEX IF NOT EXISTS knowledge_relations_to ON knowledge_relations(to_knowledge_id, relation_type);

CREATE TABLE IF NOT EXISTS knowledge_anchors (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
  entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  repo_relative_path TEXT NOT NULL,
  symbol TEXT,
  start_line INTEGER CHECK (start_line IS NULL OR start_line > 0),
  end_line INTEGER CHECK (end_line IS NULL OR end_line > 0),
  content_digest TEXT,
  captured_commit TEXT,
  last_checked_commit TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(knowledge_id, repo_relative_path, symbol)
) STRICT;

CREATE INDEX IF NOT EXISTS knowledge_anchors_knowledge ON knowledge_anchors(knowledge_id);
CREATE INDEX IF NOT EXISTS knowledge_anchors_entity ON knowledge_anchors(entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS knowledge_anchors_path ON knowledge_anchors(repo_relative_path, knowledge_id);

CREATE TABLE IF NOT EXISTS knowledge_usage_stats (
  knowledge_id TEXT PRIMARY KEY REFERENCES knowledge_units(id) ON DELETE CASCADE,
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
  knowledge_id TEXT NOT NULL REFERENCES knowledge_units(id) ON DELETE CASCADE,
  previous_risk TEXT NOT NULL CHECK (previous_risk IN ('LOW','MEDIUM','HIGH')),
  new_risk TEXT NOT NULL CHECK (new_risk IN ('LOW','MEDIUM','HIGH')),
  previous_lifecycle TEXT NOT NULL CHECK (previous_lifecycle IN ('ACTIVE','ARCHIVED','SUPERSEDED','REJECTED')),
  new_lifecycle TEXT NOT NULL CHECK (new_lifecycle IN ('ACTIVE','ARCHIVED','SUPERSEDED','REJECTED')),
  relevance_milli INTEGER NOT NULL CHECK (relevance_milli BETWEEN 0 AND 1000),
  checked_commit TEXT,
  reason_codes_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  assessor_version TEXT NOT NULL,
  assessed_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS lifecycle_knowledge ON lifecycle_assessments(knowledge_id, assessed_at DESC);

CREATE TABLE IF NOT EXISTS maintenance_cursors (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  checked_commit TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS raw_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_ref_hash TEXT NOT NULL,
  agent_kind TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_redacted_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ingestion_version INTEGER NOT NULL,
  processed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS raw_events_session_pending
  ON raw_events(project_id, session_ref_hash, processed_at, occurred_at);
CREATE INDEX IF NOT EXISTS raw_events_expiry ON raw_events(project_id, expires_at);

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

CREATE TABLE IF NOT EXISTS purge_audit (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  memory_id_hash TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'HUMAN_CLI'),
  created_at TEXT NOT NULL
) STRICT;

CREATE VIEW IF NOT EXISTS memory_projection AS
SELECT
  k.row_id,
  k.id,
  k.project_id,
  k.kind AS type,
  k.summary,
  k.body AS content,
  k.lifecycle_status,
  k.verification_state,
  k.correctness_risk,
  k.relevance_milli,
  k.completion_state,
  k.confidence_milli,
  k.importance_milli,
  coalesce((
    SELECT json_extract(e.metadata_json, '$.sourceType')
    FROM knowledge_evidence ke JOIN evidence e ON e.id = ke.evidence_id
    WHERE ke.knowledge_id = k.id AND ke.role = 'ORIGIN'
    ORDER BY e.created_at, e.id LIMIT 1
  ), (
    SELECT json_extract(e.metadata_json, '$.legacySourceType')
    FROM knowledge_evidence ke JOIN evidence e ON e.id = ke.evidence_id
    WHERE ke.knowledge_id = k.id AND ke.role = 'ORIGIN'
    ORDER BY e.created_at, e.id LIMIT 1
  ), 'CLI') AS source_type,
  (
    SELECT e.commit_sha FROM knowledge_evidence ke JOIN evidence e ON e.id = ke.evidence_id
    WHERE ke.knowledge_id = k.id AND ke.role = 'ORIGIN' AND e.commit_sha IS NOT NULL
    ORDER BY e.created_at, e.id LIMIT 1
  ) AS commit_sha,
  coalesce((
    SELECT json_extract(e.metadata_json, '$.branchName')
    FROM knowledge_evidence ke JOIN evidence e ON e.id = ke.evidence_id
    WHERE ke.knowledge_id = k.id AND ke.role = 'ORIGIN'
    ORDER BY e.created_at, e.id LIMIT 1
  ), (
    SELECT s.branch_name FROM knowledge_evidence ke
    JOIN evidence e ON e.id = ke.evidence_id
    JOIN episodes ep ON ep.id = e.episode_id
    JOIN sessions s ON s.id = ep.session_id
    WHERE ke.knowledge_id = k.id AND ke.role = 'ORIGIN'
    ORDER BY e.created_at, e.id LIMIT 1
  )) AS branch_name,
  k.created_at,
  k.updated_at,
  k.last_checked_commit,
  k.last_assessed_at,
  k.completed_at,
  k.restore_protected_until,
  k.valid_from,
  k.valid_to
FROM knowledge_units k;

CREATE TABLE IF NOT EXISTS knowledge_search_documents (
  row_id INTEGER PRIMARY KEY,
  knowledge_id TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_text TEXT NOT NULL,
  anchor_text TEXT NOT NULL,
  scope_text TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  summary,
  body,
  kind,
  entity_text,
  anchor_text,
  scope_text,
  content='knowledge_search_documents',
  content_rowid='row_id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS knowledge_search_ai AFTER INSERT ON knowledge_search_documents BEGIN
  INSERT INTO knowledge_fts(rowid, summary, body, kind, entity_text, anchor_text, scope_text)
  VALUES (new.row_id, new.summary, new.body, new.kind, new.entity_text, new.anchor_text, new.scope_text);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_search_ad AFTER DELETE ON knowledge_search_documents BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, summary, body, kind, entity_text, anchor_text, scope_text)
  VALUES ('delete', old.row_id, old.summary, old.body, old.kind, old.entity_text, old.anchor_text, old.scope_text);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_search_au AFTER UPDATE ON knowledge_search_documents BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, summary, body, kind, entity_text, anchor_text, scope_text)
  VALUES ('delete', old.row_id, old.summary, old.body, old.kind, old.entity_text, old.anchor_text, old.scope_text);
  INSERT INTO knowledge_fts(rowid, summary, body, kind, entity_text, anchor_text, scope_text)
  VALUES (new.row_id, new.summary, new.body, new.kind, new.entity_text, new.anchor_text, new.scope_text);
END;
`;
