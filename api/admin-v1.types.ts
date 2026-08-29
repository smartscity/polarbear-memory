export type MemoryType = "DECISION" | "PITFALL" | "FACT" | "CONSTRAINT" | "ARCHITECTURE" | "CONVENTION" | "TASK_STATE" | "TODO" | "WORKAROUND";
export type LifecycleStatus = "ACTIVE" | "ARCHIVED" | "SUPERSEDED" | "REJECTED";
export type VerificationState = "UNVERIFIED" | "VERIFIED" | "DISPUTED";
export type CompletionState = "OPEN" | "COMPLETED" | "CANCELLED";
export type MemoryRelationType = "SUPERSEDES" | "CONTRADICTS" | "EXTENDS" | "DERIVES" | "DEPENDS_ON" | "RELATED_TO";
export type EntityKind = "MODULE" | "FILE" | "SYMBOL" | "SERVICE" | "API" | "DATABASE_TABLE" | "DEPENDENCY" | "ISSUE" | "CONCEPT";
export type EntityRole = "SUBJECT" | "AFFECTS" | "REFERENCES" | "DEPENDS_ON" | "RELATED";

export type FileAnchor = {
  path: string; entityId?: string; symbol?: string; startLine?: number; endLine?: number;
  contentDigest?: string; capturedCommit?: string; lastCheckedCommit?: string;
};
export type MemoryRelation = { sourceMemoryId: string; targetMemoryId: string; type: MemoryRelationType; reason: string; createdAt: string };
export type Evidence = {
  id: string; projectId: string; episodeId?: string;
  type: "FILE_RANGE" | "SYMBOL" | "GIT_COMMIT" | "TEST" | "USER_STATEMENT" | "AGENT_RESULT" | "ADR" | "ISSUE" | "MR" | "CI" | "OTHER";
  sourceRef?: string; digest: string; observedAt: string; commitSha?: string; trustLevel: "LOW" | "MEDIUM" | "HIGH";
  metadata?: Record<string, string | number | boolean | null>; createdAt: string;
};
export type Entity = {
  id: string; projectId: string; kind: EntityKind; canonicalKey: string; displayName: string;
  metadata?: Record<string, string | number | boolean | null>; createdAt: string; updatedAt: string;
};

export type MemoryRecord = {
  id: string; projectId: string; type: MemoryType; summary: string; content: string;
  lifecycleStatus: LifecycleStatus; verificationState: VerificationState;
  correctnessRisk: "LOW" | "MEDIUM" | "HIGH"; relevance: number;
  completionState: CompletionState; confidence: number; importance: number;
  sourceType: "CLI" | "MCP" | "HOOK" | "FIXTURE"; commitSha?: string; branchName?: string; files: string[];
  fileAnchors: FileAnchor[]; relations: MemoryRelation[];
  usage: { candidateCount: number; selectedCount: number; positiveFeedbackCount: number; negativeFeedbackCount: number; lastCandidateAt?: string; lastSelectedAt?: string; lastFeedbackAt?: string };
  revisionCount: number;
  latestAssessment?: { previousRisk: string; newRisk: string; previousLifecycle: string; newLifecycle: string; relevance: number; checkedCommit?: string; reasonCodes: string[]; policyVersion: string; assessorVersion: string; assessedAt: string };
  lastCheckedCommit?: string; lastAssessedAt?: string; completedAt?: string; restoreProtectedUntil?: string;
  createdAt: string; updatedAt: string; validFrom?: string; validTo?: string;
  evidence: Array<{ evidence: Evidence; role: "ORIGIN" | "SUPPORTS" | "VERIFIES" | "CONTRADICTS" | "INVALIDATES"; confidence: number }>;
  entities: Array<{ entity: Entity; role: EntityRole; confidence: number }>;
};

export type RecordMemoryRequest = {
  type: MemoryType; summary: string; content?: string; files?: string[]; fileAnchors?: FileAnchor[];
  completionState?: CompletionState; confidence?: number; importance?: number; commitSha?: string; branchName?: string;
  validFrom?: string; validTo?: string; episodeId?: string; evidenceIds?: string[];
  entities?: Array<{ kind: EntityKind; canonicalKey: string; displayName: string; role?: EntityRole; confidence?: number; metadata?: Record<string, string | number | boolean | null> }>;
};
export type TokenSavingsStats = {
  contextPackCount: number; candidateCount: number; selectedCount: number; baselineTokens: number; contextTokens: number;
  estimatedSavedTokens: number; measurementStartedAt: string; lastContextAt?: string; resetCount: number;
};
export type HelloResponse = { apiVersion: string; engineVersion: string; capabilities: MemoryCapability[]; transport: "local-user-socket" };
export type ProjectStatusResponse = { project: { id: string; name: string }; counts: Record<string, number>; recent: MemoryRecord[] };
export type MemoryListResponse = { items: MemoryRecord[]; offset: number; limit: number; nextOffset: number | null };
export type ContextExplainResponse = { markdown: string; estimatedTokens: number; selected: number; selectedMemoryIds: string[]; warningMemoryIds: string[] };
export type PromotePreviewResponse = { path: string; content: string; sha256: string };
export type PromoteResponse = { path: string; sha256: string };
export type MemoryRevision = { revision: number; content: string; summary: string; reason: string; actor: "HUMAN_CLI" | "AGENT_MCP" | "SYSTEM"; createdAt: string };
export type MemoryHistoryResponse = { items: MemoryRevision[] };
export type DiagnosticsResponse = { engineVersion: string; apiVersion: string; schemaVersion: number; runtime: string; platform: string; architecture: string; networkPolicy: "disabled"; counts: Record<string, number> };
export type MaintenanceAction = { memoryId: string; previousRisk: string; newRisk: string; previousLifecycle: string; newLifecycle: string; relevance: number; checkedCommit?: string; reasonCodes: string[] };
export type MaintenancePlan = { policyVersion: string; assessorVersion: string; dryRun: boolean; checkedCommit?: string; evaluated: number; changed: number; rawEventsDeleted: number; actions: MaintenanceAction[] };
export type BackupInspection = { fileName: string; schemaVersion: number; integrity: "ok"; bytes: number; sha256: string; pages?: number };
export type BackupListResponse = { items: BackupInspection[] };
export type ProjectMemoryConfig = { captureMode: "off" | "manual" | "summary"; rawEventRetentionDays: number; defaultContextBudget: number };
export type BackupRestorePreview = { backup: BackupInspection; confirmation: string; warning: string };
export type BackupRestoreResult = { restored: BackupInspection; rollbackFileName: string | null };
export type MemoryPurgePreview = { memory: Pick<MemoryRecord, "id" | "summary" | "type" | "revisionCount">; confirmation: string; warning: string };
export type MemoryPurgeResult = { purgedMemoryIdHash: string };
