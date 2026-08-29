import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CompletionState, FileAnchor, MaintenanceAction } from "../domain/lifecycle.js";
import { ASSESSOR_VERSION, POLICY_VERSION } from "../domain/lifecycle.js";
import type { Memory, VerificationState } from "../domain/memory.js";
import { KnowledgeRepository, validateReason } from "./knowledge-repository.js";
import { recordLifecycleAssessment } from "./lifecycle-assessments.js";
import type { MemoryProjectionRow as MemoryRow } from "./memory-read-model.js";
import { inImmediateTransaction } from "./sqlite-transaction.js";

/** Owns verification, archival and four-layer maintenance transitions. */
export class LifecycleService {
  readonly #database: DatabaseSync;
  readonly #knowledge: KnowledgeRepository;

  constructor(database: DatabaseSync, knowledge: KnowledgeRepository) {
    this.#database = database;
    this.#knowledge = knowledge;
  }

  verify(
    projectId: string,
    memoryId: string,
    state: VerificationState,
    reason: string,
    actor: "HUMAN_CLI" | "AGENT_MCP" = "AGENT_MCP",
    evidence: { anchors?: FileAnchor[]; checkedCommit?: string } = {},
  ): Memory {
    validateReason(reason, "Verification");
    const memory = this.#knowledge.get(projectId, memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    const now = new Date().toISOString();
    inImmediateTransaction(this.#database, () => {
      this.#database.prepare(`
        UPDATE knowledge_units SET verification_state = ?, correctness_risk = 'LOW',
          last_checked_commit = coalesce(?, last_checked_commit), last_assessed_at = ?, updated_at = ?
        WHERE project_id = ? AND id = ?
      `).run(state, evidence.checkedCommit ?? null, now, now, projectId, memoryId);
      for (const anchor of evidence.anchors ?? []) this.#knowledge.upsertFileAnchor(projectId, memoryId, anchor, now, evidence.checkedCommit);
      recordLifecycleAssessment(this.#database, {
        knowledgeId: memoryId,
        previousRisk: memory.correctnessRisk,
        newRisk: "LOW",
        previousLifecycle: memory.lifecycleStatus,
        newLifecycle: memory.lifecycleStatus,
        relevance: memory.relevance,
        checkedCommit: evidence.checkedCommit,
        reasonCodes: [actor === "HUMAN_CLI" ? "HUMAN_VERIFIED_CURRENT_SOURCE" : "AGENT_VERIFIED_CURRENT_SOURCE"],
        policyVersion: POLICY_VERSION,
        assessorVersion: ASSESSOR_VERSION,
        assessedAt: now,
      });
      this.#knowledge.appendRevision(memory, `verification:${state}:${reason.trim()}`, actor, now);
      this.#knowledge.recordVerificationEvidence(projectId, memoryId, state, reason, evidence.checkedCommit, now);
      this.#knowledge.refreshIndex(memoryId);
    });
    const updated = this.#knowledge.get(projectId, memoryId);
    if (!updated) throw new Error(`Memory not found after verification: ${memoryId}`);
    return updated;
  }


  archive(
    projectId: string,
    memoryId: string,
    reason: string,
    actor: "HUMAN_CLI" | "AGENT_MCP" = "AGENT_MCP",
  ): Memory {
    validateReason(reason, "Archive");
    const memory = this.#knowledge.get(projectId, memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    if (memory.lifecycleStatus === "ARCHIVED") return memory;
    const now = new Date().toISOString();
    inImmediateTransaction(this.#database, () => {
      this.#database.prepare("UPDATE knowledge_units SET lifecycle_status = 'ARCHIVED', archived_at = ?, updated_at = ? WHERE project_id = ? AND id = ?")
        .run(now, now, projectId, memoryId);
      recordLifecycleAssessment(this.#database, {
        knowledgeId: memoryId,
        previousRisk: memory.correctnessRisk,
        newRisk: memory.correctnessRisk,
        previousLifecycle: memory.lifecycleStatus,
        newLifecycle: "ARCHIVED",
        relevance: memory.relevance,
        checkedCommit: memory.lastCheckedCommit,
        reasonCodes: [actor === "HUMAN_CLI" ? "HUMAN_ARCHIVE" : "AGENT_ARCHIVE"],
        policyVersion: POLICY_VERSION,
        assessorVersion: ASSESSOR_VERSION,
        assessedAt: now,
      });
      this.#knowledge.appendRevision(memory, `archive:${reason.trim()}`, actor, now);
    });
    const updated = this.#knowledge.get(projectId, memoryId);
    if (!updated) throw new Error(`Memory not found after archive: ${memoryId}`);
    return updated;
  }


  restore(projectId: string, memoryId: string, reason: string): Memory {
    validateReason(reason, "Restore");
    const memory = this.#knowledge.get(projectId, memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    if (memory.lifecycleStatus !== "ARCHIVED") throw new Error("Only archived Memory can be restored.");
    const now = new Date();
    const protectedUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString();
    inImmediateTransaction(this.#database, () => {
      this.#database.prepare(`
        UPDATE knowledge_units SET lifecycle_status = 'ACTIVE', archived_at = NULL, restore_protected_until = ?, updated_at = ?
        WHERE project_id = ? AND id = ?
      `).run(protectedUntil, now.toISOString(), projectId, memoryId);
      recordLifecycleAssessment(this.#database, {
        knowledgeId: memoryId,
        previousRisk: memory.correctnessRisk,
        newRisk: memory.correctnessRisk,
        previousLifecycle: "ARCHIVED",
        newLifecycle: "ACTIVE",
        relevance: memory.relevance,
        checkedCommit: memory.lastCheckedCommit,
        reasonCodes: ["HUMAN_RESTORE_GRACE_30D"],
        policyVersion: POLICY_VERSION,
        assessorVersion: ASSESSOR_VERSION,
        assessedAt: now.toISOString(),
      });
      this.#knowledge.appendRevision(memory, `restore:${reason.trim()}`, "HUMAN_CLI", now.toISOString());
    });
    const restored = this.#knowledge.get(projectId, memoryId);
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
    validateReason(reason, "Completion");
    const memory = this.#knowledge.get(projectId, memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    if (memory.type !== "TASK_STATE" && memory.type !== "TODO") {
      throw new Error("Only TASK_STATE and TODO Memory can be completed or cancelled.");
    }
    if (memory.completionState === state) return memory;
    const now = clock.toISOString();
    inImmediateTransaction(this.#database, () => {
      this.#database.prepare(`
        UPDATE knowledge_units SET completion_state = ?, completed_at = ?, relevance_milli = 0, updated_at = ?
        WHERE project_id = ? AND id = ?
      `).run(state, now, now, projectId, memoryId);
      this.#knowledge.appendRevision(memory, `completion:${state}:${reason.trim()}`, "HUMAN_CLI", now);
    });
    const completed = this.#knowledge.get(projectId, memoryId);
    if (!completed) throw new Error(`Memory not found after completion: ${memoryId}`);
    return completed;
  }


  maintenanceCursor(projectId: string): string | undefined {
    const row = this.#database.prepare("SELECT checked_commit FROM maintenance_cursors WHERE project_id = ?")
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
    if (targetCommit && paths.length === 0) {
      const candidate = this.#database.prepare(`
        SELECT 1 FROM knowledge_units k
        WHERE k.project_id = ? AND k.lifecycle_status = 'ACTIVE'
          AND (k.last_checked_commit IS NULL OR k.last_checked_commit <> ?
            OR (k.completion_state <> 'OPEN' AND k.completed_at <= ?
              AND (k.restore_protected_until IS NULL OR k.restore_protected_until <= ?))
            OR k.correctness_risk = 'HIGH'
            OR EXISTS (
              SELECT 1 FROM knowledge_usage_stats u WHERE u.knowledge_id = k.id
                AND (coalesce(u.last_candidate_at, '') > coalesce(k.last_assessed_at, '')
                  OR coalesce(u.last_selected_at, '') > coalesce(k.last_assessed_at, '')
                  OR coalesce(u.last_feedback_at, '') > coalesce(k.last_assessed_at, ''))
            ))
        LIMIT 1
      `).get(projectId, targetCommit, archiveBefore ?? "", now ?? "");
      if (!candidate) return [];
    }
    const changedAnchorClause = paths.length > 0
      ? ` OR EXISTS (
          SELECT 1 FROM knowledge_anchors a
          WHERE a.knowledge_id = memory_projection.id AND a.repo_relative_path IN (${paths.map(() => "?").join(",")})
        )`
      : "";
    const rows = this.#database.prepare(`
      SELECT * FROM memory_projection WHERE project_id = ? AND lifecycle_status = 'ACTIVE'
        AND (? IS NULL OR coalesce(last_checked_commit, '') <> ?
          OR (completion_state <> 'OPEN' AND completed_at <= ?
            AND (restore_protected_until IS NULL OR restore_protected_until <= ?))
          OR correctness_risk = 'HIGH'
          OR EXISTS (
            SELECT 1 FROM knowledge_usage_stats u WHERE u.knowledge_id = memory_projection.id
              AND (coalesce(u.last_candidate_at, '') > coalesce(memory_projection.last_assessed_at, '')
                OR coalesce(u.last_selected_at, '') > coalesce(memory_projection.last_assessed_at, '')
                OR coalesce(u.last_feedback_at, '') > coalesce(memory_projection.last_assessed_at, ''))
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
    return rows.map((row) => this.#knowledge.hydrate(row));
  }

  countExpiredRawEvents(projectId: string, now: string): number {
    const row = this.#database.prepare("SELECT count(*) AS count FROM raw_events WHERE project_id = ? AND expires_at <= ?")
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
    inImmediateTransaction(this.#database, () => {
      for (const action of actions) {
        const memory = this.#knowledge.get(projectId, action.memoryId);
        if (!memory) continue;
        const stateChanged = memory.correctnessRisk !== action.newRisk
          || memory.lifecycleStatus !== action.newLifecycle
          || memory.relevance !== action.relevance
          || memory.lastCheckedCommit !== action.checkedCommit;
        if (!stateChanged) continue;
        this.#database.prepare(`
          UPDATE knowledge_units SET correctness_risk = ?, lifecycle_status = ?, relevance_milli = ?,
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
          this.#knowledge.appendRevision(memory, `maintenance:${action.reasonCodes.join(",")}`, "SYSTEM", now);
        }
        recordLifecycleAssessment(this.#database, {
          knowledgeId: action.memoryId,
          previousRisk: action.previousRisk,
          newRisk: action.newRisk,
          previousLifecycle: action.previousLifecycle,
          newLifecycle: action.newLifecycle,
          relevance: action.relevance,
          checkedCommit: action.checkedCommit,
          reasonCodes: action.reasonCodes,
          policyVersion,
          assessorVersion,
          assessedAt: now,
        });
      }
      rawEventsDeleted = Number(this.#database.prepare("DELETE FROM raw_events WHERE project_id = ? AND expires_at <= ?")
        .run(projectId, now).changes);
      this.#database.prepare(`
        INSERT INTO maintenance_cursors(project_id, checked_commit, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET checked_commit = excluded.checked_commit, updated_at = excluded.updated_at
      `).run(projectId, cursorCommit ?? null, now);
    });
    return rawEventsDeleted;
  }


}

