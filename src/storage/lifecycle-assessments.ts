import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CorrectnessRisk } from "../domain/lifecycle.js";
import type { Memory } from "../domain/memory.js";

export interface LifecycleAssessmentRecord {
  knowledgeId: string;
  previousRisk: CorrectnessRisk;
  newRisk: CorrectnessRisk;
  previousLifecycle: Memory["lifecycleStatus"];
  newLifecycle: Memory["lifecycleStatus"];
  relevance: number;
  checkedCommit?: string | undefined;
  reasonCodes: string[];
  policyVersion: string;
  assessorVersion: string;
  assessedAt: string;
}

/** Writes the canonical lifecycle audit shape from one typed call site. */
export function recordLifecycleAssessment(database: DatabaseSync, record: LifecycleAssessmentRecord): void {
  database.prepare(`
    INSERT INTO lifecycle_assessments(
      id, knowledge_id, previous_risk, new_risk, previous_lifecycle, new_lifecycle,
      relevance_milli, checked_commit, reason_codes_json, policy_version, assessor_version, assessed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    record.knowledgeId,
    record.previousRisk,
    record.newRisk,
    record.previousLifecycle,
    record.newLifecycle,
    record.relevance,
    record.checkedCommit ?? null,
    JSON.stringify(record.reasonCodes),
    record.policyVersion,
    record.assessorVersion,
    record.assessedAt,
  );
}
