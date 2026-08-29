import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryRevision, MemoryRelationType } from "../domain/lifecycle.js";
import { ASSESSOR_VERSION, POLICY_VERSION } from "../domain/lifecycle.js";
import type { Memory, RecordMemoryInput } from "../domain/memory.js";
import { validateRecordInput } from "../domain/memory.js";
import { CaptureService } from "./capture-service.js";
import { KnowledgeRepository, validateReason } from "./knowledge-repository.js";
import { recordLifecycleAssessment } from "./lifecycle-assessments.js";
import type { MemoryProjectionRow as MemoryRow } from "./memory-read-model.js";
import { inImmediateTransaction } from "./sqlite-transaction.js";
import { redactText } from "../security/redaction.js";

/** Owns canonical Knowledge write use cases and relation invariants. */
export class KnowledgeCommandService {
  readonly #database: DatabaseSync;
  readonly #knowledge: KnowledgeRepository;
  readonly #capture: CaptureService;

  constructor(database: DatabaseSync, knowledge: KnowledgeRepository, capture: CaptureService) {
    this.#database = database;
    this.#knowledge = knowledge;
    this.#capture = capture;
  }

  record(projectId: string, input: RecordMemoryInput): Memory {
    validateRecordInput(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    const summary = redactText(input.summary.trim());
    const content = redactText(input.content?.trim() || summary);
    const confidence = input.confidence ?? 700;
    const importance = input.importance ?? 500;
    const sourceType = input.sourceType ?? "CLI";
    const completionState = input.completionState ?? "OPEN";
    const hash = createHash("sha256").update(`${input.type}\0${summary}\0${content}`).digest("hex");
    const versionHash = createHash("sha256").update(`${summary}\0${content}`).digest("hex");
    const supersededIds: string[] = [];

    const storedId = inImmediateTransaction(this.#database, () => {
      const duplicate = this.#database.prepare(
        "SELECT id FROM knowledge_units WHERE project_id = ? AND current_content_hash = ?",
      ).get(projectId, hash) as { id: string } | undefined;
      if (duplicate) {
        for (const file of new Set(input.files ?? [])) this.#knowledge.upsertFileAnchor(projectId, duplicate.id, { path: file }, now);
        for (const anchor of input.fileAnchors ?? []) this.#knowledge.upsertFileAnchor(projectId, duplicate.id, anchor, now);
        this.#knowledge.refreshIndex(duplicate.id);
        return duplicate.id;
      }
      if (input.type === "TASK_STATE") {
        const activeStates = this.#database.prepare(`
          SELECT * FROM memory_projection
          WHERE project_id = ? AND type = 'TASK_STATE' AND lifecycle_status = 'ACTIVE'
            AND coalesce(branch_name, '') = coalesce(?, '')
          ORDER BY updated_at DESC, id ASC
        `).all(projectId, input.branchName ?? null) as unknown as MemoryRow[];
        for (const row of activeStates) {
          const previous = this.#knowledge.hydrate(row);
          this.#knowledge.appendRevision(previous, `superseded-by:${id}`, sourceType === "MCP" ? "AGENT_MCP" : "SYSTEM", now);
          this.#database.prepare("UPDATE knowledge_units SET lifecycle_status = 'SUPERSEDED', valid_to = coalesce(valid_to, ?), updated_at = ? WHERE id = ?")
            .run(now, now, row.id);
          recordLifecycleAssessment(this.#database, {
            knowledgeId: row.id,
            previousRisk: previous.correctnessRisk,
            newRisk: previous.correctnessRisk,
            previousLifecycle: "ACTIVE",
            newLifecycle: "SUPERSEDED",
            relevance: previous.relevance,
            checkedCommit: input.commitSha ?? previous.lastCheckedCommit,
            reasonCodes: ["TASK_STATE_SINGLE_ACTIVE"],
            policyVersion: POLICY_VERSION,
            assessorVersion: ASSESSOR_VERSION,
            assessedAt: now,
          });
          supersededIds.push(row.id);
        }
      }
      this.#database.prepare(`
        INSERT INTO knowledge_units(
          id, workspace_id, project_id, kind, summary, body, scope_kind, scope_ref, confidence_milli, importance_milli,
          relevance_milli, completion_state, completed_at, valid_from, valid_to,
          current_content_hash, created_at, updated_at, extractor_version
        ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, projectId, input.type, summary, content, input.scopeKind ?? null, input.scopeRef ?? null,
        confidence, importance,
        completionState === "OPEN" ? importance : 0,
        completionState,
        completionState === "OPEN" ? null : now,
        input.validFrom ?? now,
        input.validTo ?? null,
        hash,
        now,
        now,
        sourceType === "HOOK" ? "claude-hook-v1" : "manual-v1",
      );
      this.#database.prepare(`
        INSERT INTO knowledge_versions(id, knowledge_id, version_no, body, summary, content_hash, valid_from, reason, actor_kind, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, 'recorded', ?, ?)
      `).run(
        randomUUID(),
        id,
        content,
        summary,
        versionHash,
        input.validFrom ?? now,
        sourceType === "CLI" ? "HUMAN_CLI" : sourceType === "MCP" ? "AGENT_MCP" : "SYSTEM",
        now,
      );
      this.#knowledge.recordOrigin(projectId, id, { ...input, summary }, content, hash, now);
      for (const evidenceId of new Set(input.evidenceIds ?? [])) {
        const exists = this.#database.prepare("SELECT 1 FROM evidence WHERE project_id = ? AND id = ?").get(projectId, evidenceId);
        if (!exists) throw new Error(`Evidence not found: ${evidenceId}`);
        this.#database.prepare(`
          INSERT OR IGNORE INTO knowledge_evidence(knowledge_id, evidence_id, role, confidence_milli, created_at)
          VALUES (?, ?, 'SUPPORTS', ?, ?)
        `).run(id, evidenceId, confidence, now);
      }
      for (const entityInput of input.entities ?? []) {
        const entity = this.#capture.upsertEntity(projectId, entityInput);
        this.#database.prepare(`
          INSERT OR IGNORE INTO knowledge_entities(knowledge_id, entity_id, role, confidence_milli, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, entity.id, entityInput.role ?? "SUBJECT", entityInput.confidence ?? confidence, now);
      }
      for (const file of new Set(input.files ?? [])) this.#knowledge.upsertFileAnchor(projectId, id, { path: file }, now);
      for (const anchor of input.fileAnchors ?? []) this.#knowledge.upsertFileAnchor(projectId, id, anchor, now);
      this.#database.prepare("INSERT INTO knowledge_usage_stats(knowledge_id) VALUES (?)").run(id);
      for (const targetId of supersededIds) {
        this.#database.prepare(`
          INSERT INTO knowledge_relations(
            id, from_knowledge_id, to_knowledge_id, relation_type, valid_from,
            confidence_milli, reason, created_at
          ) VALUES (?, ?, ?, 'SUPERSEDES', ?, 1000, 'task-state-single-active', ?)
        `).run(randomUUID(), id, targetId, now, now);
      }
      this.#knowledge.refreshIndex(id);
      return id;
    });
    const memory = this.#knowledge.get(projectId, storedId);
    if (!memory) throw new Error("Memory disappeared after insert.");
    return memory;
  }


  get(projectId: string, memoryId: string): Memory | undefined {
    const row = this.#database.prepare("SELECT * FROM memory_projection WHERE project_id = ? AND id = ?").get(projectId, memoryId) as MemoryRow | undefined;
    return row ? this.#knowledge.hydrate(row) : undefined;
  }


  update(projectId: string, memoryId: string, input: { summary: string; content: string; reason: string }): Memory {
    validateReason(input.reason, "Edit");
    const current = this.#knowledge.get(projectId, memoryId);
    if (!current) throw new Error(`Memory not found: ${memoryId}`);
    validateRecordInput({ type: current.type, summary: input.summary, content: input.content });
    const summary = input.summary.trim();
    const content = input.content.trim();
    const hash = createHash("sha256").update(`${current.type}\0${summary}\0${content}`).digest("hex");
    const now = new Date().toISOString();
    inImmediateTransaction(this.#database, () => {
      this.#database.prepare(`
        UPDATE knowledge_units SET summary = ?, body = ?, current_content_hash = ?, verification_state = 'UNVERIFIED',
          updated_at = ? WHERE project_id = ? AND id = ?
      `).run(summary, content, hash, now, projectId, memoryId);
      this.#knowledge.appendRevision({ ...current, summary, content }, `edit:${input.reason.trim()}`, "HUMAN_CLI", now);
      this.#knowledge.refreshIndex(memoryId);
    });
    const updated = this.#knowledge.get(projectId, memoryId);
    if (!updated) throw new Error(`Memory not found after edit: ${memoryId}`);
    return updated;
  }


  purge(projectId: string, memoryId: string, reason: string): { purgedMemoryIdHash: string } {
    validateReason(reason, "Purge");
    const memory = this.#knowledge.get(projectId, memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    const purgedMemoryIdHash = createHash("sha256").update(memory.id).digest("hex");
    const now = new Date().toISOString();
    inImmediateTransaction(this.#database, () => {
      this.#database.prepare(`
        INSERT INTO purge_audit(id, project_id, memory_id_hash, memory_type, reason, actor_kind, created_at)
        VALUES (?, ?, ?, ?, ?, 'HUMAN_CLI', ?)
      `).run(randomUUID(), projectId, purgedMemoryIdHash, memory.type, reason.trim(), now);
      this.#database.prepare("DELETE FROM knowledge_units WHERE project_id = ? AND id = ?").run(projectId, memoryId);
    });
    return { purgedMemoryIdHash };
  }


  revisions(projectId: string, memoryId: string): MemoryRevision[] {
    if (!this.#knowledge.get(projectId, memoryId)) throw new Error(`Memory not found: ${memoryId}`);
    const rows = this.#database.prepare(`
      SELECT version_no AS revision_no, body AS content, summary, coalesce(reason, '') AS reason, actor_kind, created_at
      FROM knowledge_versions WHERE knowledge_id = ? ORDER BY version_no DESC
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


  addRelation(
    projectId: string,
    sourceMemoryId: string,
    targetMemoryId: string,
    type: MemoryRelationType,
    reason: string,
  ): void {
    validateReason(reason, "Relation");
    if (sourceMemoryId === targetMemoryId) throw new Error("A Memory cannot relate to itself.");
    const source = this.#knowledge.get(projectId, sourceMemoryId);
    const target = this.#knowledge.get(projectId, targetMemoryId);
    if (!source || !target) throw new Error("Both related Memory records must exist in this project.");
    if (type === "SUPERSEDES" || type === "DERIVES") {
      const cycle = this.#database.prepare(`
        WITH RECURSIVE related(knowledge_id) AS (
          SELECT to_knowledge_id
          FROM knowledge_relations
          WHERE from_knowledge_id = ? AND relation_type = ?
          UNION
          SELECT relation.to_knowledge_id
          FROM knowledge_relations relation
          JOIN related ON relation.from_knowledge_id = related.knowledge_id
          WHERE relation.relation_type = ?
        )
        SELECT 1 AS found FROM related WHERE knowledge_id = ? LIMIT 1
      `).get(targetMemoryId, type, type, sourceMemoryId) as { found: number } | undefined;
      if (cycle) throw new Error(`A ${type} relation cannot create a cycle.`);
    }
    const now = new Date().toISOString();
    inImmediateTransaction(this.#database, () => {
      this.#database.prepare(`
        INSERT OR IGNORE INTO knowledge_relations(
          id, from_knowledge_id, to_knowledge_id, relation_type, valid_from,
          confidence_milli, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, 1000, ?, ?)
      `).run(randomUUID(), sourceMemoryId, targetMemoryId, type, now, reason.trim(), now);
      if (type === "SUPERSEDES" && target.lifecycleStatus === "ACTIVE") {
        this.#database.prepare("UPDATE knowledge_units SET lifecycle_status = 'SUPERSEDED', valid_to = coalesce(valid_to, ?), updated_at = ? WHERE id = ?")
          .run(now, now, targetMemoryId);
        recordLifecycleAssessment(this.#database, {
          knowledgeId: targetMemoryId,
          previousRisk: target.correctnessRisk,
          newRisk: target.correctnessRisk,
          previousLifecycle: "ACTIVE",
          newLifecycle: "SUPERSEDED",
          relevance: target.relevance,
          checkedCommit: source.commitSha ?? target.lastCheckedCommit,
          reasonCodes: ["EXPLICIT_SUPERSEDES"],
          policyVersion: POLICY_VERSION,
          assessorVersion: ASSESSOR_VERSION,
          assessedAt: now,
        });
        this.#knowledge.appendRevision(target, `superseded-by:${sourceMemoryId}:${reason.trim()}`, "HUMAN_CLI", now);
      } else if (type === "CONTRADICTS") {
        this.#database.prepare(`
          UPDATE knowledge_units SET verification_state = 'DISPUTED', updated_at = ?
          WHERE project_id = ? AND id IN (?, ?)
        `).run(now, projectId, sourceMemoryId, targetMemoryId);
        this.#knowledge.appendRevision(source, `contradicts:${targetMemoryId}:${reason.trim()}`, "HUMAN_CLI", now);
        this.#knowledge.appendRevision(target, `contradicts:${sourceMemoryId}:${reason.trim()}`, "HUMAN_CLI", now);
      }
    });
  }


}
