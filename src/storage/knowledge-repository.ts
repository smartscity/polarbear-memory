import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FileAnchor } from "../domain/lifecycle.js";
import type { EvidenceRole, EntityKind } from "../domain/knowledge.js";
import type { Memory, RecordMemoryInput, VerificationState } from "../domain/memory.js";
import { KnowledgeSearchIndex } from "./knowledge-index.js";
import { hydrateMemories, type MemoryProjectionRow } from "./memory-read-model.js";

/** Canonical Knowledge aggregate persistence shared by command and lifecycle services. */
export class KnowledgeRepository {
  readonly #database: DatabaseSync;
  readonly #searchIndex: KnowledgeSearchIndex;

  constructor(database: DatabaseSync, searchIndex: KnowledgeSearchIndex) {
    this.#database = database;
    this.#searchIndex = searchIndex;
  }

  get(projectId: string, knowledgeId: string): Memory | undefined {
    const row = this.#database.prepare("SELECT * FROM memory_projection WHERE project_id = ? AND id = ?")
      .get(projectId, knowledgeId) as unknown as MemoryProjectionRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  require(projectId: string, knowledgeId: string): Memory {
    const memory = this.get(projectId, knowledgeId);
    if (!memory) throw new Error(`Memory not found: ${knowledgeId}`);
    return memory;
  }

  hydrate(row: MemoryProjectionRow): Memory {
    return hydrateMemories(this.#database, [row])[0] as Memory;
  }

  appendRevision(memory: Memory, reason: string, actor: RevisionActor, now: string): void {
    const next = this.#database.prepare("SELECT coalesce(max(version_no), 0) + 1 AS revision FROM knowledge_versions WHERE knowledge_id = ?")
      .get(memory.id) as { revision: number };
    const contentHash = createHash("sha256").update(`${memory.summary}\0${memory.content}`).digest("hex");
    this.#database.prepare(`
      INSERT INTO knowledge_versions(
        id, knowledge_id, version_no, body, summary, content_hash, valid_from,
        reason, actor_kind, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), memory.id, next.revision, memory.content, memory.summary,
      contentHash, memory.validFrom ?? now, reason, actor, now);
  }

  recordOrigin(
    projectId: string,
    knowledgeId: string,
    input: RecordMemoryInput,
    body: string,
    contentHash: string,
    now: string,
  ): void {
    const episodeId = input.episodeId ?? randomUUID();
    const evidenceId = randomUUID();
    const sourceType = input.sourceType ?? "CLI";
    const sourceDigest = createHash("sha256").update(`${knowledgeId}\0${sourceType}\0${contentHash}`).digest("hex");
    if (input.episodeId) {
      if (!this.#database.prepare("SELECT 1 FROM episodes WHERE project_id = ? AND id = ?").get(projectId, input.episodeId)) {
        throw new Error(`Episode not found: ${input.episodeId}`);
      }
    } else {
      this.#database.prepare(`
        INSERT INTO episodes(
          id, project_id, episode_type, occurred_at, ingested_at, source_digest,
          summary, retention_class, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(episodeId, projectId,
        sourceType === "CLI" && input.type === "DECISION" ? "USER_DECISION" : "TOOL_RESULT",
        now, now, sourceDigest, input.summary.trim(),
        input.type === "TASK_STATE" || input.type === "TODO" ? "SHORT" : "DURABLE", now);
    }
    const evidenceType = sourceType === "CLI" ? "USER_STATEMENT" : sourceType === "FIXTURE" ? "OTHER" : "AGENT_RESULT";
    this.#database.prepare(`
      INSERT INTO evidence(
        id, project_id, episode_id, evidence_type, source_ref, digest,
        observed_at, commit_sha, trust_level, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(evidenceId, projectId, episodeId, evidenceType,
      input.commitSha ? `git:${input.commitSha}` : sourceType,
      createHash("sha256").update(`${body}\0${input.commitSha ?? ""}`).digest("hex"), now,
      input.commitSha ?? null, sourceType === "CLI" ? "HIGH" : sourceType === "FIXTURE" ? "LOW" : "MEDIUM",
      JSON.stringify({ sourceType, ...(input.branchName ? { branchName: input.branchName } : {}) }), now);
    this.#database.prepare(`
      INSERT INTO knowledge_evidence(knowledge_id, evidence_id, role, confidence_milli, created_at)
      VALUES (?, ?, 'ORIGIN', ?, ?)
    `).run(knowledgeId, evidenceId, input.confidence ?? 700, now);
  }

  recordVerificationEvidence(
    projectId: string,
    knowledgeId: string,
    state: VerificationState,
    reason: string,
    checkedCommit: string | undefined,
    now: string,
  ): void {
    const episodeId = randomUUID();
    const evidenceId = randomUUID();
    const digest = createHash("sha256").update(`${knowledgeId}\0${state}\0${reason}\0${checkedCommit ?? ""}`).digest("hex");
    this.#database.prepare(`
      INSERT INTO episodes(
        id, project_id, episode_type, occurred_at, ingested_at, source_digest,
        summary, retention_class, created_at
      ) VALUES (?, ?, 'TOOL_RESULT', ?, ?, ?, ?, 'DURABLE', ?)
    `).run(episodeId, projectId, now, now, digest, `Verification ${state}: ${reason.trim()}`, now);
    this.#database.prepare(`
      INSERT INTO evidence(
        id, project_id, episode_id, evidence_type, source_ref, digest,
        observed_at, commit_sha, trust_level, metadata_json, created_at
      ) VALUES (?, ?, ?, 'AGENT_RESULT', ?, ?, ?, ?, ?, ?, ?)
    `).run(evidenceId, projectId, episodeId, checkedCommit ? `git:${checkedCommit}` : "verification",
      digest, now, checkedCommit ?? null, state === "VERIFIED" ? "HIGH" : "MEDIUM",
      JSON.stringify({ verificationState: state, reason: reason.trim() }), now);
    const role: EvidenceRole = state === "VERIFIED" ? "VERIFIES" : state === "DISPUTED" ? "CONTRADICTS" : "SUPPORTS";
    this.#database.prepare(`
      INSERT INTO knowledge_evidence(knowledge_id, evidence_id, role, confidence_milli, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(knowledgeId, evidenceId, role, state === "VERIFIED" ? 1000 : 700, now);
  }

  upsertFileAnchor(projectId: string, knowledgeId: string, anchor: FileAnchor, now: string, lastCheckedCommit?: string): void {
    const canonicalKey = anchor.symbol ? `symbol://${anchor.path}#${anchor.symbol}` : `file://${anchor.path}`;
    const kind: EntityKind = anchor.symbol ? "SYMBOL" : "FILE";
    const existing = this.#database.prepare("SELECT id FROM entities WHERE project_id = ? AND canonical_key = ?")
      .get(projectId, canonicalKey) as { id: string } | undefined;
    const entityId = existing?.id ?? randomUUID();
    this.#database.prepare(`
      INSERT INTO entities(id, project_id, kind, canonical_key, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, canonical_key) DO UPDATE SET
        display_name = excluded.display_name, updated_at = excluded.updated_at
    `).run(entityId, projectId, kind, canonicalKey, anchor.symbol ?? anchor.path, now, now);
    this.#database.prepare(`
      INSERT OR IGNORE INTO knowledge_entities(knowledge_id, entity_id, role, confidence_milli, created_at)
      VALUES (?, ?, 'REFERENCES', 1000, ?)
    `).run(knowledgeId, entityId, now);
    const current = this.#database.prepare(`
      SELECT id FROM knowledge_anchors WHERE knowledge_id = ? AND repo_relative_path = ? AND symbol IS ?
    `).get(knowledgeId, anchor.path, anchor.symbol ?? null) as { id: string } | undefined;
    if (current) {
      this.#database.prepare(`
        UPDATE knowledge_anchors SET entity_id = ?, start_line = coalesce(?, start_line),
          end_line = coalesce(?, end_line), content_digest = coalesce(?, content_digest),
          captured_commit = coalesce(?, captured_commit), last_checked_commit = coalesce(?, last_checked_commit),
          updated_at = ? WHERE id = ?
      `).run(entityId, anchor.startLine ?? null, anchor.endLine ?? null, anchor.contentDigest ?? null,
        anchor.capturedCommit ?? null, lastCheckedCommit ?? anchor.lastCheckedCommit ?? null, now, current.id);
    } else {
      this.#database.prepare(`
        INSERT INTO knowledge_anchors(
          id, knowledge_id, entity_id, repo_relative_path, symbol, start_line, end_line,
          content_digest, captured_commit, last_checked_commit, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), knowledgeId, entityId, anchor.path, anchor.symbol ?? null,
        anchor.startLine ?? null, anchor.endLine ?? null, anchor.contentDigest ?? null,
        anchor.capturedCommit ?? null, lastCheckedCommit ?? anchor.lastCheckedCommit ?? null, now, now);
    }
  }

  refreshIndex(knowledgeId: string): void {
    this.#searchIndex.refresh(knowledgeId);
  }
}

export type RevisionActor = "HUMAN_CLI" | "AGENT_MCP" | "SYSTEM";

export function validateReason(reason: string, label: string): void {
  if (reason.trim().length === 0 || Buffer.byteLength(reason, "utf8") > 2_048) {
    throw new Error(`${label} reason must contain 1–2048 bytes.`);
  }
}
