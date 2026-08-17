export const POLICY_VERSION = "mvp3-v1";
export const ASSESSOR_VERSION = "mvp3-v1";

export type CorrectnessRisk = "LOW" | "MEDIUM" | "HIGH";
export type CompletionState = "OPEN" | "COMPLETED" | "CANCELLED";
export type MemoryRelationType = "SUPERSEDES" | "CONTRADICTS";

export interface FileAnchor {
  path: string;
  contentDigest?: string;
  capturedCommit?: string;
}

export interface MemoryRelation {
  sourceMemoryId: string;
  targetMemoryId: string;
  type: MemoryRelationType;
  reason: string;
  createdAt: string;
}

export interface UsageStats {
  candidateCount: number;
  selectedCount: number;
  positiveFeedbackCount: number;
  negativeFeedbackCount: number;
  lastCandidateAt?: string;
  lastSelectedAt?: string;
  lastFeedbackAt?: string;
}

export interface MaintenanceAction {
  memoryId: string;
  previousRisk: CorrectnessRisk;
  newRisk: CorrectnessRisk;
  previousLifecycle: "ACTIVE" | "ARCHIVED" | "SUPERSEDED" | "REJECTED";
  newLifecycle: "ACTIVE" | "ARCHIVED" | "SUPERSEDED" | "REJECTED";
  relevance: number;
  checkedCommit?: string;
  reasonCodes: string[];
}

export interface LifecycleAssessment {
  previousRisk: CorrectnessRisk;
  newRisk: CorrectnessRisk;
  previousLifecycle: "ACTIVE" | "ARCHIVED" | "SUPERSEDED" | "REJECTED";
  newLifecycle: "ACTIVE" | "ARCHIVED" | "SUPERSEDED" | "REJECTED";
  relevance: number;
  checkedCommit?: string;
  reasonCodes: string[];
  policyVersion: string;
  assessorVersion: string;
  assessedAt: string;
}

export interface MemoryRevision {
  revision: number;
  content: string;
  summary: string;
  reason: string;
  actor: "HUMAN_CLI" | "AGENT_MCP" | "SYSTEM";
  createdAt: string;
}

export interface MaintenancePlan {
  policyVersion: typeof POLICY_VERSION;
  assessorVersion: typeof ASSESSOR_VERSION;
  dryRun: boolean;
  checkedCommit?: string;
  evaluated: number;
  changed: number;
  rawEventsDeleted: number;
  actions: MaintenanceAction[];
}
