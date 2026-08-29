import type { CorrectnessRisk } from "./lifecycle.js";
import type { LifecycleStatus, VerificationState } from "./memory.js";

export const KNOWLEDGE_KINDS = [
  "DECISION",
  "PITFALL",
  "FACT",
  "CONSTRAINT",
  "ARCHITECTURE",
  "CONVENTION",
  "TASK_STATE",
  "TODO",
  "WORKAROUND",
] as const;

export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export type AgentKind = "CLAUDE" | "CURSOR" | "CODEX" | "OTHER";
export type CaptureStatus = "OPEN" | "ENDED" | "PARTIAL" | "FAILED";
export type EpisodeType =
  | "AGENT_SESSION_END"
  | "USER_DECISION"
  | "GIT_COMMIT"
  | "TEST_RESULT"
  | "CI_RESULT"
  | "MR_MERGED"
  | "FILE_CHANGE"
  | "INCIDENT"
  | "TOOL_RESULT";
export type RetentionClass = "TRANSIENT" | "SHORT" | "STANDARD" | "DURABLE";
export type EvidenceType =
  | "FILE_RANGE"
  | "SYMBOL"
  | "GIT_COMMIT"
  | "TEST"
  | "USER_STATEMENT"
  | "AGENT_RESULT"
  | "ADR"
  | "ISSUE"
  | "MR"
  | "CI"
  | "OTHER";
export type TrustLevel = "LOW" | "MEDIUM" | "HIGH";
export type EvidenceRole = "ORIGIN" | "SUPPORTS" | "VERIFIES" | "CONTRADICTS" | "INVALIDATES";
export type EntityKind = "MODULE" | "FILE" | "SYMBOL" | "SERVICE" | "API" | "DATABASE_TABLE" | "DEPENDENCY" | "ISSUE" | "CONCEPT";
export type EntityRole = "SUBJECT" | "AFFECTS" | "REFERENCES" | "DEPENDS_ON" | "RELATED";
export type KnowledgeRelationType = "SUPERSEDES" | "CONTRADICTS" | "EXTENDS" | "DERIVES" | "DEPENDS_ON" | "RELATED_TO";

export interface Session {
  id: string;
  projectId: string;
  agentKind: AgentKind;
  externalSessionRefHash?: string;
  branchName?: string;
  headStart?: string;
  headEnd?: string;
  startedAt: string;
  endedAt?: string;
  captureStatus: CaptureStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Episode {
  id: string;
  projectId: string;
  sessionId?: string;
  type: EpisodeType;
  occurredAt: string;
  ingestedAt: string;
  sourceDigest: string;
  summary: string;
  payloadRef?: string;
  retentionClass: RetentionClass;
  createdAt: string;
}

export interface Evidence {
  id: string;
  projectId: string;
  episodeId?: string;
  type: EvidenceType;
  sourceRef?: string;
  digest: string;
  observedAt: string;
  commitSha?: string;
  trustLevel: TrustLevel;
  metadata?: Record<string, string | number | boolean | null>;
  createdAt: string;
}

export interface Entity {
  id: string;
  projectId: string;
  kind: EntityKind;
  canonicalKey: string;
  displayName: string;
  metadata?: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeVersion {
  id: string;
  knowledgeId: string;
  version: number;
  summary: string;
  body: string;
  contentHash: string;
  validFrom?: string;
  validTo?: string;
  actor: "HUMAN_CLI" | "AGENT_MCP" | "SYSTEM";
  reason?: string;
  createdAt: string;
}

export interface KnowledgeUnitSnapshot {
  id: string;
  workspaceId: string;
  projectId: string;
  kind: KnowledgeKind;
  summary: string;
  body: string;
  scopeKind?: string;
  scopeRef?: string;
  lifecycleStatus: LifecycleStatus;
  verificationState: VerificationState;
  correctnessRisk: CorrectnessRisk;
  confidence: number;
  importance: number;
  relevance: number;
  validFrom?: string;
  validTo?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface KnowledgeEvidenceLink {
  evidence: Evidence;
  role: EvidenceRole;
  confidence: number;
}

export interface KnowledgeEntityLink {
  entity: Entity;
  role: EntityRole;
  confidence: number;
}
