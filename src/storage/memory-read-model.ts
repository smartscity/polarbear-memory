import type { DatabaseSync } from "node:sqlite";
import type { CompletionState, CorrectnessRisk, MemoryRelationType } from "../domain/lifecycle.js";
import type { EntityKind, EntityRole, EvidenceRole, EvidenceType, TrustLevel } from "../domain/knowledge.js";
import type { Memory, MemoryType } from "../domain/memory.js";

export interface MemoryProjectionRow {
  id: string;
  project_id: string;
  type: string;
  summary: string;
  content: string;
  lifecycle_status: string;
  verification_state: string;
  correctness_risk: string;
  relevance_milli: number;
  completion_state: string;
  confidence_milli: number;
  importance_milli: number;
  source_type: string;
  commit_sha: string | null;
  branch_name: string | null;
  created_at: string;
  updated_at: string;
  last_checked_commit: string | null;
  last_assessed_at: string | null;
  completed_at: string | null;
  restore_protected_until: string | null;
  valid_from: string | null;
  valid_to: string | null;
}

/** Batch-hydrates the public compatibility aggregate without N+1 queries. */
export function hydrateMemories(database: DatabaseSync, rows: MemoryProjectionRow[]): Memory[] {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((row) => row.id))];
  const placeholders = ids.map(() => "?").join(",");
  const grouped = <T extends { knowledge_id: string }>(items: T[]): Map<string, T[]> => {
    const result = new Map<string, T[]>();
    for (const item of items) result.set(item.knowledge_id, [...(result.get(item.knowledge_id) ?? []), item]);
    return result;
  };
  const anchors = grouped(database.prepare(`
    SELECT knowledge_id, entity_id, repo_relative_path, symbol, start_line, end_line,
      content_digest, captured_commit, last_checked_commit
    FROM knowledge_anchors WHERE knowledge_id IN (${placeholders})
    ORDER BY repo_relative_path, symbol
  `).all(...ids) as Array<Record<string, string | number | null> & { knowledge_id: string }>);
  const relationRows = database.prepare(`
    SELECT from_knowledge_id, to_knowledge_id, relation_type, coalesce(reason, '') AS reason, created_at
    FROM knowledge_relations
    WHERE from_knowledge_id IN (${placeholders}) OR to_knowledge_id IN (${placeholders})
    ORDER BY created_at, from_knowledge_id, to_knowledge_id
  `).all(...ids, ...ids) as unknown as RelationRow[];
  const relations = new Map<string, RelationRow[]>();
  const requestedIds = new Set(ids);
  for (const relation of relationRows) {
    for (const id of new Set([relation.from_knowledge_id, relation.to_knowledge_id])) {
      if (requestedIds.has(id)) relations.set(id, [...(relations.get(id) ?? []), relation]);
    }
  }
  const usage = new Map((database.prepare(`
    SELECT * FROM knowledge_usage_stats WHERE knowledge_id IN (${placeholders})
  `).all(...ids) as RelatedRow[]).map((row) => [row.knowledge_id, row]));
  const assessments = new Map((database.prepare(`
    SELECT * FROM lifecycle_assessments la
    WHERE knowledge_id IN (${placeholders}) AND NOT EXISTS (
      SELECT 1 FROM lifecycle_assessments newer
      WHERE newer.knowledge_id = la.knowledge_id
        AND (newer.assessed_at > la.assessed_at OR (newer.assessed_at = la.assessed_at AND newer.id > la.id))
    )
  `).all(...ids) as RelatedRow[]).map((row) => [row.knowledge_id, row]));
  const revisions = new Map((database.prepare(`
    SELECT knowledge_id, count(*) AS count FROM knowledge_versions
    WHERE knowledge_id IN (${placeholders}) GROUP BY knowledge_id
  `).all(...ids) as Array<{ knowledge_id: string; count: number }>).map((row) => [row.knowledge_id, row.count]));
  const evidence = grouped(database.prepare(`
    SELECT ke.knowledge_id, ke.role, ke.confidence_milli,
      e.id, e.project_id, e.episode_id, e.evidence_type, e.source_ref, e.digest,
      e.observed_at, e.commit_sha, e.trust_level, e.metadata_json, e.created_at
    FROM knowledge_evidence ke JOIN evidence e ON e.id = ke.evidence_id
    WHERE ke.knowledge_id IN (${placeholders})
    ORDER BY e.observed_at DESC, e.id
  `).all(...ids) as RelatedRow[]);
  const entities = grouped(database.prepare(`
    SELECT ke.knowledge_id, ke.role, ke.confidence_milli,
      e.id, e.project_id, e.kind, e.canonical_key, e.display_name,
      e.metadata_json, e.created_at, e.updated_at
    FROM knowledge_entities ke JOIN entities e ON e.id = ke.entity_id
    WHERE ke.knowledge_id IN (${placeholders})
    ORDER BY e.kind, e.canonical_key
  `).all(...ids) as RelatedRow[]);

  return rows.map((row) => {
    const rowAnchors = anchors.get(row.id) ?? [];
    const rowUsage = usage.get(row.id);
    const assessment = assessments.get(row.id);
    return {
      id: row.id,
      projectId: row.project_id,
      type: row.type as MemoryType,
      summary: row.summary,
      content: row.content,
      lifecycleStatus: row.lifecycle_status as Memory["lifecycleStatus"],
      verificationState: row.verification_state as Memory["verificationState"],
      correctnessRisk: (row.correctness_risk ?? "LOW") as CorrectnessRisk,
      relevance: row.relevance_milli ?? row.importance_milli,
      completionState: (row.completion_state ?? "OPEN") as CompletionState,
      confidence: row.confidence_milli,
      importance: row.importance_milli,
      sourceType: row.source_type as Memory["sourceType"],
      ...(row.commit_sha ? { commitSha: row.commit_sha } : {}),
      ...(row.branch_name ? { branchName: row.branch_name } : {}),
      files: [...new Set(rowAnchors.map((anchor) => String(anchor.repo_relative_path)))],
      fileAnchors: rowAnchors.map((anchor) => ({
        path: String(anchor.repo_relative_path),
        ...(anchor.entity_id ? { entityId: String(anchor.entity_id) } : {}),
        ...(anchor.symbol ? { symbol: String(anchor.symbol) } : {}),
        ...(anchor.start_line ? { startLine: Number(anchor.start_line) } : {}),
        ...(anchor.end_line ? { endLine: Number(anchor.end_line) } : {}),
        ...(anchor.content_digest ? { contentDigest: String(anchor.content_digest) } : {}),
        ...(anchor.captured_commit ? { capturedCommit: String(anchor.captured_commit) } : {}),
        ...(anchor.last_checked_commit ? { lastCheckedCommit: String(anchor.last_checked_commit) } : {}),
      })),
      relations: (relations.get(row.id) ?? []).map((relation) => ({
        sourceMemoryId: relation.from_knowledge_id,
        targetMemoryId: relation.to_knowledge_id,
        type: relation.relation_type as MemoryRelationType,
        reason: relation.reason,
        createdAt: relation.created_at,
      })),
      usage: {
        candidateCount: Number(rowUsage?.candidate_count ?? 0),
        selectedCount: Number(rowUsage?.selected_count ?? 0),
        positiveFeedbackCount: Number(rowUsage?.positive_feedback_count ?? 0),
        negativeFeedbackCount: Number(rowUsage?.negative_feedback_count ?? 0),
        ...(rowUsage?.last_candidate_at ? { lastCandidateAt: String(rowUsage.last_candidate_at) } : {}),
        ...(rowUsage?.last_selected_at ? { lastSelectedAt: String(rowUsage.last_selected_at) } : {}),
        ...(rowUsage?.last_feedback_at ? { lastFeedbackAt: String(rowUsage.last_feedback_at) } : {}),
      },
      revisionCount: revisions.get(row.id) ?? 0,
      ...(assessment ? {
        latestAssessment: {
          previousRisk: String(assessment.previous_risk) as CorrectnessRisk,
          newRisk: String(assessment.new_risk) as CorrectnessRisk,
          previousLifecycle: String(assessment.previous_lifecycle) as Memory["lifecycleStatus"],
          newLifecycle: String(assessment.new_lifecycle) as Memory["lifecycleStatus"],
          relevance: Number(assessment.relevance_milli),
          ...(assessment.checked_commit ? { checkedCommit: String(assessment.checked_commit) } : {}),
          reasonCodes: JSON.parse(String(assessment.reason_codes_json)) as string[],
          policyVersion: String(assessment.policy_version),
          assessorVersion: String(assessment.assessor_version),
          assessedAt: String(assessment.assessed_at),
        },
      } : {}),
      ...(row.last_checked_commit ? { lastCheckedCommit: row.last_checked_commit } : {}),
      ...(row.last_assessed_at ? { lastAssessedAt: row.last_assessed_at } : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.restore_protected_until ? { restoreProtectedUntil: row.restore_protected_until } : {}),
      ...(row.valid_from ? { validFrom: row.valid_from } : {}),
      ...(row.valid_to ? { validTo: row.valid_to } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      evidence: (evidence.get(row.id) ?? []).map((item) => ({
        role: String(item.role) as EvidenceRole,
        confidence: Number(item.confidence_milli),
        evidence: {
          id: String(item.id),
          projectId: String(item.project_id),
          ...(item.episode_id ? { episodeId: String(item.episode_id) } : {}),
          type: String(item.evidence_type) as EvidenceType,
          ...(item.source_ref ? { sourceRef: String(item.source_ref) } : {}),
          digest: String(item.digest),
          observedAt: String(item.observed_at),
          ...(item.commit_sha ? { commitSha: String(item.commit_sha) } : {}),
          trustLevel: String(item.trust_level) as TrustLevel,
          ...(item.metadata_json ? { metadata: JSON.parse(String(item.metadata_json)) as Metadata } : {}),
          createdAt: String(item.created_at),
        },
      })),
      entities: (entities.get(row.id) ?? []).map((item) => ({
        role: String(item.role) as EntityRole,
        confidence: Number(item.confidence_milli),
        entity: {
          id: String(item.id),
          projectId: String(item.project_id),
          kind: String(item.kind) as EntityKind,
          canonicalKey: String(item.canonical_key),
          displayName: String(item.display_name),
          ...(item.metadata_json ? { metadata: JSON.parse(String(item.metadata_json)) as Metadata } : {}),
          createdAt: String(item.created_at),
          updatedAt: String(item.updated_at),
        },
      })),
    };
  });
}

type Metadata = Record<string, string | number | boolean | null>;
type RelatedRow = Record<string, string | number | null> & { knowledge_id: string };

interface RelationRow {
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
  reason: string;
  created_at: string;
}
