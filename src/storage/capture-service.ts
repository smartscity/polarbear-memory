import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentKind,
  CaptureStatus,
  Entity,
  EntityKind,
  EntityRole,
  Episode,
  EpisodeType,
  Evidence,
  EvidenceRole,
  EvidenceType,
  RetentionClass,
  Session,
  TrustLevel,
} from "../domain/knowledge.js";
import type { Memory } from "../domain/memory.js";
import { KnowledgeSearchIndex } from "./knowledge-index.js";
import { hydrateMemories, type MemoryProjectionRow } from "./memory-read-model.js";

/** Owns normalized Session, Episode, Evidence and Entity capture operations. */
export class CaptureService {
  readonly #database: DatabaseSync;
  readonly #searchIndex: KnowledgeSearchIndex;

  constructor(database: DatabaseSync, searchIndex: KnowledgeSearchIndex) {
    this.#database = database;
    this.#searchIndex = searchIndex;
  }

  upsertSession(projectId: string, input: SessionInput): Session {
    const now = new Date().toISOString();
    const existing = input.externalSessionRefHash
      ? this.#database.prepare(`
          SELECT id FROM sessions WHERE project_id = ? AND agent_kind = ? AND external_session_ref_hash = ?
        `).get(projectId, input.agentKind, input.externalSessionRefHash) as { id: string } | undefined
      : undefined;
    const id = existing?.id ?? input.id ?? randomUUID();
    this.#database.prepare(`
      INSERT INTO sessions(
        id, project_id, agent_kind, external_session_ref_hash, branch_name, head_start,
        started_at, capture_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        branch_name = coalesce(excluded.branch_name, sessions.branch_name),
        head_start = coalesce(sessions.head_start, excluded.head_start),
        capture_status = excluded.capture_status, updated_at = excluded.updated_at
    `).run(id, projectId, input.agentKind, input.externalSessionRefHash ?? null,
      input.branchName ?? null, input.headStart ?? null, input.startedAt ?? now,
      input.captureStatus ?? "OPEN", now, now);
    return this.#session(projectId, id);
  }

  endSession(projectId: string, sessionId: string, input: EndSessionInput): Session {
    const endedAt = input.endedAt ?? new Date().toISOString();
    const result = this.#database.prepare(`
      UPDATE sessions SET ended_at = ?, head_end = coalesce(?, head_end),
        capture_status = ?, updated_at = ? WHERE project_id = ? AND id = ?
    `).run(endedAt, input.headEnd ?? null, input.captureStatus ?? "ENDED", endedAt, projectId, sessionId);
    if (Number(result.changes) !== 1) throw new Error(`Session not found: ${sessionId}`);
    return this.#session(projectId, sessionId);
  }

  recordEpisode(projectId: string, input: EpisodeInput): Episode {
    if (!input.summary.trim()) throw new Error("Episode summary must not be empty.");
    const now = new Date().toISOString();
    const existing = this.#database.prepare(`
      SELECT id FROM episodes WHERE project_id = ? AND source_digest = ? AND episode_type = ?
    `).get(projectId, input.sourceDigest, input.type) as { id: string } | undefined;
    const id = existing?.id ?? input.id ?? randomUUID();
    this.#database.prepare(`
      INSERT OR IGNORE INTO episodes(
        id, project_id, session_id, episode_type, occurred_at, ingested_at,
        source_digest, summary, payload_ref, retention_class, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, input.sessionId ?? null, input.type, input.occurredAt ?? now, now,
      input.sourceDigest, input.summary.trim(), input.payloadRef ?? null, input.retentionClass ?? "STANDARD", now);
    return this.#episode(projectId, id);
  }

  recordEvidence(projectId: string, input: EvidenceInput): Evidence {
    const now = new Date().toISOString();
    const existing = this.#database.prepare(`
      SELECT id FROM evidence WHERE project_id = ? AND digest = ? AND evidence_type = ? AND source_ref IS ?
    `).get(projectId, input.digest, input.type, input.sourceRef ?? null) as { id: string } | undefined;
    const id = existing?.id ?? input.id ?? randomUUID();
    this.#database.prepare(`
      INSERT OR IGNORE INTO evidence(
        id, project_id, episode_id, evidence_type, source_ref, digest,
        observed_at, commit_sha, trust_level, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, input.episodeId ?? null, input.type, input.sourceRef ?? null, input.digest,
      input.observedAt ?? now, input.commitSha ?? null, input.trustLevel ?? "MEDIUM",
      input.metadata ? JSON.stringify(input.metadata) : null, now);
    return this.#evidence(projectId, id);
  }

  linkEvidence(projectId: string, memoryId: string, evidenceId: string, role: EvidenceRole, confidence = 700): Memory {
    assertMilli(confidence, "Evidence confidence");
    this.#requireMemory(projectId, memoryId);
    if (!this.#database.prepare("SELECT 1 FROM evidence WHERE project_id = ? AND id = ?").get(projectId, evidenceId)) {
      throw new Error(`Evidence not found: ${evidenceId}`);
    }
    this.#database.prepare(`
      INSERT INTO knowledge_evidence(knowledge_id, evidence_id, role, confidence_milli, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(knowledge_id, evidence_id, role) DO UPDATE SET confidence_milli = excluded.confidence_milli
    `).run(memoryId, evidenceId, role, confidence, new Date().toISOString());
    return this.#requireMemory(projectId, memoryId);
  }

  upsertEntity(projectId: string, input: EntityInput): Entity {
    if (!input.canonicalKey.trim() || !input.displayName.trim()) throw new Error("Entity canonical key and display name are required.");
    const now = new Date().toISOString();
    const existing = this.#database.prepare("SELECT id FROM entities WHERE project_id = ? AND canonical_key = ?")
      .get(projectId, input.canonicalKey.trim()) as { id: string } | undefined;
    const id = existing?.id ?? input.id ?? randomUUID();
    this.#database.prepare(`
      INSERT INTO entities(id, project_id, kind, canonical_key, display_name, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, canonical_key) DO UPDATE SET
        kind = excluded.kind, display_name = excluded.display_name,
        metadata_json = coalesce(excluded.metadata_json, entities.metadata_json), updated_at = excluded.updated_at
    `).run(id, projectId, input.kind, input.canonicalKey.trim(), input.displayName.trim(),
      input.metadata ? JSON.stringify(input.metadata) : null, now, now);
    const linked = this.#database.prepare("SELECT knowledge_id FROM knowledge_entities WHERE entity_id = ?")
      .all(id) as Array<{ knowledge_id: string }>;
    for (const row of linked) this.#searchIndex.refresh(row.knowledge_id);
    return this.#entity(projectId, id);
  }

  linkEntity(projectId: string, memoryId: string, entityId: string, role: EntityRole, confidence = 700): Memory {
    assertMilli(confidence, "Entity confidence");
    this.#requireMemory(projectId, memoryId);
    if (!this.#database.prepare("SELECT 1 FROM entities WHERE project_id = ? AND id = ?").get(projectId, entityId)) {
      throw new Error(`Entity not found: ${entityId}`);
    }
    this.#database.prepare(`
      INSERT INTO knowledge_entities(knowledge_id, entity_id, role, confidence_milli, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(knowledge_id, entity_id, role) DO UPDATE SET confidence_milli = excluded.confidence_milli
    `).run(memoryId, entityId, role, confidence, new Date().toISOString());
    this.#searchIndex.refresh(memoryId);
    return this.#requireMemory(projectId, memoryId);
  }

  #requireMemory(projectId: string, memoryId: string): Memory {
    const row = this.#database.prepare("SELECT * FROM memory_projection WHERE project_id = ? AND id = ?")
      .get(projectId, memoryId) as unknown as MemoryProjectionRow | undefined;
    if (!row) throw new Error(`Memory not found: ${memoryId}`);
    return hydrateMemories(this.#database, [row])[0] as Memory;
  }

  #session(projectId: string, id: string): Session {
    const row = this.#database.prepare("SELECT * FROM sessions WHERE project_id = ? AND id = ?").get(projectId, id) as Record<string, string | null> | undefined;
    if (!row) throw new Error(`Session not found: ${id}`);
    return { id: String(row.id), projectId: String(row.project_id), agentKind: String(row.agent_kind) as AgentKind,
      ...(row.external_session_ref_hash ? { externalSessionRefHash: row.external_session_ref_hash } : {}),
      ...(row.branch_name ? { branchName: row.branch_name } : {}), ...(row.head_start ? { headStart: row.head_start } : {}),
      ...(row.head_end ? { headEnd: row.head_end } : {}), startedAt: String(row.started_at),
      ...(row.ended_at ? { endedAt: row.ended_at } : {}), captureStatus: String(row.capture_status) as CaptureStatus,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }

  #episode(projectId: string, id: string): Episode {
    const row = this.#database.prepare("SELECT * FROM episodes WHERE project_id = ? AND id = ?").get(projectId, id) as Record<string, string | null> | undefined;
    if (!row) throw new Error(`Episode not found: ${id}`);
    return { id: String(row.id), projectId: String(row.project_id), ...(row.session_id ? { sessionId: row.session_id } : {}),
      type: String(row.episode_type) as EpisodeType, occurredAt: String(row.occurred_at), ingestedAt: String(row.ingested_at),
      sourceDigest: String(row.source_digest), summary: String(row.summary), ...(row.payload_ref ? { payloadRef: row.payload_ref } : {}),
      retentionClass: String(row.retention_class) as RetentionClass, createdAt: String(row.created_at) };
  }

  #evidence(projectId: string, id: string): Evidence {
    const row = this.#database.prepare("SELECT * FROM evidence WHERE project_id = ? AND id = ?").get(projectId, id) as Record<string, string | null> | undefined;
    if (!row) throw new Error(`Evidence not found: ${id}`);
    return { id: String(row.id), projectId: String(row.project_id), ...(row.episode_id ? { episodeId: row.episode_id } : {}),
      type: String(row.evidence_type) as EvidenceType, ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
      digest: String(row.digest), observedAt: String(row.observed_at), ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
      trustLevel: String(row.trust_level) as TrustLevel,
      ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as Metadata } : {}), createdAt: String(row.created_at) };
  }

  #entity(projectId: string, id: string): Entity {
    const row = this.#database.prepare("SELECT * FROM entities WHERE project_id = ? AND id = ?").get(projectId, id) as Record<string, string | null> | undefined;
    if (!row) throw new Error(`Entity not found: ${id}`);
    return { id: String(row.id), projectId: String(row.project_id), kind: String(row.kind) as EntityKind,
      canonicalKey: String(row.canonical_key), displayName: String(row.display_name),
      ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as Metadata } : {}),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }
}

type Metadata = Record<string, string | number | boolean | null>;
export interface SessionInput { id?: string; agentKind: AgentKind; externalSessionRefHash?: string; branchName?: string; headStart?: string; startedAt?: string; captureStatus?: CaptureStatus }
export interface EndSessionInput { endedAt?: string; headEnd?: string; captureStatus?: CaptureStatus }
export interface EpisodeInput { id?: string; sessionId?: string; type: EpisodeType; occurredAt?: string; sourceDigest: string; summary: string; payloadRef?: string; retentionClass?: RetentionClass }
export interface EvidenceInput { id?: string; episodeId?: string; type: EvidenceType; sourceRef?: string; digest: string; observedAt?: string; commitSha?: string; trustLevel?: TrustLevel; metadata?: Metadata }
export interface EntityInput { id?: string; kind: EntityKind; canonicalKey: string; displayName: string; metadata?: Metadata }

function assertMilli(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 1_000) throw new Error(`${label} must be an integer between 0 and 1000.`);
}
