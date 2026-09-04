export const CURRENT_SCHEMA_VERSION = 10;
export const V2_MIGRATION_CHECKSUM = "v2-fact-episode-entity-2026-08-28";
export const CONTEXT_OS_MIGRATION_CHECKSUM = "v10-context-activation-2026-09-05";

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

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) > 0),
  objective TEXT NOT NULL CHECK (length(objective) > 0),
  status TEXT NOT NULL CHECK (status IN ('PLANNED','ACTIVE','BLOCKED','VERIFYING','DONE','CANCELLED')),
  phase TEXT NOT NULL CHECK (phase IN ('DISCOVERY','DESIGN','IMPLEMENTATION','DEBUGGING','VERIFICATION','REVIEW','DOCUMENTATION')),
  priority_milli INTEGER NOT NULL DEFAULT 500 CHECK (priority_milli BETWEEN 0 AND 1000),
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  last_checkpoint_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS tasks_project_state ON tasks(project_id, status, priority_milli DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  integration_mode TEXT NOT NULL CHECK (integration_mode IN ('ASSISTED','MANAGED')),
  external_session_ref_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('OPEN','ENDED','FAILED')),
  estimated_context_tokens INTEGER NOT NULL DEFAULT 0 CHECK (estimated_context_tokens >= 0),
  turn_count INTEGER NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  compact_count INTEGER NOT NULL DEFAULT 0 CHECK (compact_count >= 0),
  task_affinity_milli INTEGER NOT NULL DEFAULT 1000 CHECK (task_affinity_milli BETWEEN 0 AND 1000),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, provider, external_session_ref_hash)
) STRICT;

CREATE INDEX IF NOT EXISTS agent_sessions_project ON agent_sessions(project_id, provider, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS execution_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PLANNED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  phase TEXT NOT NULL CHECK (phase IN ('DISCOVERY','DESIGN','IMPLEMENTATION','DEBUGGING','VERIFICATION','REVIEW','DOCUMENTATION')),
  context_packet_id TEXT,
  checkpoint_id TEXT,
  rotation_reason TEXT,
  model TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  ended_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS execution_runs_task ON execution_runs(project_id, task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS execution_runs_session ON execution_runs(agent_session_id, started_at DESC);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  execution_run_id TEXT REFERENCES execution_runs(id) ON DELETE SET NULL,
  agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_redacted_json TEXT NOT NULL,
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  estimated_tokens INTEGER NOT NULL DEFAULT 0 CHECK (estimated_tokens >= 0),
  importance_milli INTEGER NOT NULL DEFAULT 500 CHECK (importance_milli BETWEEN 0 AND 1000),
  source_fingerprint TEXT NOT NULL,
  persisted_as_memory INTEGER NOT NULL DEFAULT 0 CHECK (persisted_as_memory IN (0,1)),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, source_fingerprint)
) STRICT;

CREATE INDEX IF NOT EXISTS observations_pending ON observations(project_id, persisted_as_memory, importance_milli DESC, occurred_at);
CREATE INDEX IF NOT EXISTS observations_task ON observations(task_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS lifecycle_counters (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ACCEPTED','REJECTED','SPOOLED','REPLAYED','FAIL_OPEN')),
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  total_latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (total_latency_ms >= 0),
  max_latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (max_latency_ms >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, provider, event_type, outcome)
) STRICT;

CREATE INDEX IF NOT EXISTS lifecycle_counters_project ON lifecycle_counters(project_id, provider, event_type);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_run_id TEXT REFERENCES execution_runs(id) ON DELETE SET NULL,
  previous_checkpoint_id TEXT REFERENCES checkpoints(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('PLANNED','ACTIVE','BLOCKED','VERIFYING','DONE','CANCELLED')),
  phase TEXT NOT NULL CHECK (phase IN ('DISCOVERY','DESIGN','IMPLEMENTATION','DEBUGGING','VERIFICATION','REVIEW','DOCUMENTATION')),
  summary TEXT NOT NULL CHECK (length(summary) > 0),
  state_json TEXT NOT NULL,
  delta_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  source_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, source_fingerprint)
) STRICT;

CREATE INDEX IF NOT EXISTS checkpoints_task ON checkpoints(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS retrieval_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  query TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  selected_count INTEGER NOT NULL CHECK (selected_count >= 0),
  candidate_tokens INTEGER NOT NULL CHECK (candidate_tokens >= 0),
  selected_tokens INTEGER NOT NULL CHECK (selected_tokens >= 0),
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  budget_json TEXT NOT NULL,
  exclusions_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS retrieval_runs_task ON retrieval_runs(project_id, task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS context_packets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  execution_run_id TEXT REFERENCES execution_runs(id) ON DELETE SET NULL,
  retrieval_run_id TEXT NOT NULL REFERENCES retrieval_runs(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  current_request TEXT NOT NULL,
  provider TEXT,
  max_tokens INTEGER NOT NULL CHECK (max_tokens > 0),
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  packet_hash TEXT NOT NULL,
  rendered_text TEXT NOT NULL,
  structured_payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, packet_hash)
) STRICT;

CREATE INDEX IF NOT EXISTS context_packets_task ON context_packets(project_id, task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS context_packet_items (
  packet_id TEXT NOT NULL REFERENCES context_packets(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK (rank > 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('TASK','CHECKPOINT','MEMORY')),
  source_id TEXT NOT NULL,
  category TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
  score_milli INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
  reason TEXT NOT NULL,
  content TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  PRIMARY KEY(packet_id, rank)
) STRICT;

CREATE INDEX IF NOT EXISTS context_packet_items_source ON context_packet_items(source_type, source_id);

CREATE TABLE IF NOT EXISTS context_deliveries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  packet_id TEXT NOT NULL REFERENCES context_packets(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  integration_mode TEXT NOT NULL CHECK (integration_mode IN ('ASSISTED','MANAGED')),
  delivery_point TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DELIVERED','FAILED')),
  failure_code TEXT,
  failure_reason TEXT,
  source_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, source_fingerprint)
) STRICT;

CREATE INDEX IF NOT EXISTS context_deliveries_packet ON context_deliveries(packet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS context_deliveries_project ON context_deliveries(project_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  execution_run_id TEXT REFERENCES execution_runs(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  context_packet_tokens INTEGER NOT NULL DEFAULT 0 CHECK (context_packet_tokens >= 0),
  useful_context_tokens INTEGER NOT NULL DEFAULT 0 CHECK (useful_context_tokens >= 0),
  successful INTEGER NOT NULL DEFAULT 0 CHECK (successful IN (0,1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS usage_ledger_project ON usage_ledger(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_ledger_task ON usage_ledger(task_id, created_at DESC);

CREATE VIEW IF NOT EXISTS memory_projection AS
SELECT
  k.row_id,
  k.id,
  k.project_id,
  k.kind AS type,
  k.summary,
  k.body AS content,
  k.scope_kind,
  k.scope_ref,
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
