export type MemoryType = "DECISION" | "PITFALL" | "FACT" | "CONSTRAINT" | "ARCHITECTURE" | "CONVENTION" | "TASK_STATE" | "TODO" | "WORKAROUND";
export type LifecycleStatus = "ACTIVE" | "ARCHIVED" | "SUPERSEDED" | "REJECTED";
export type VerificationState = "UNVERIFIED" | "VERIFIED" | "DISPUTED";
export type CompletionState = "OPEN" | "COMPLETED" | "CANCELLED";
export type MemoryRelationType = "SUPERSEDES" | "CONTRADICTS" | "EXTENDS" | "DERIVES" | "DEPENDS_ON" | "RELATED_TO";
export type EntityKind = "MODULE" | "FILE" | "SYMBOL" | "SERVICE" | "API" | "DATABASE_TABLE" | "DEPENDENCY" | "ISSUE" | "CONCEPT";
export type EntityRole = "SUBJECT" | "AFFECTS" | "REFERENCES" | "DEPENDS_ON" | "RELATED";
export type TaskStatus = "PLANNED" | "ACTIVE" | "BLOCKED" | "VERIFYING" | "DONE" | "CANCELLED";
export type TaskPhase = "DISCOVERY" | "DESIGN" | "IMPLEMENTATION" | "DEBUGGING" | "VERIFICATION" | "REVIEW" | "DOCUMENTATION";
export type ContextCategory = "OBJECTIVE" | "WORKING_MEMORY" | "CONSTRAINTS" | "DECISIONS" | "ARCHITECTURE" | "EPISODES" | "VERIFICATION" | "SEMANTIC" | "SOURCES";

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
  createdAt: string; updatedAt: string; validFrom?: string; validTo?: string; scopeKind?: string; scopeRef?: string;
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
export type TaskRecord = {
  id: string; projectId: string; title: string; objective: string; status: TaskStatus; phase: TaskPhase;
  priority: number; parentTaskId?: string; lastCheckpointId?: string; createdAt: string; updatedAt: string; completedAt?: string;
};
export type CheckpointState = {
  changed: string[]; learned: string[]; decisionsAdded: string[]; constraintsAdded: string[];
  failedAttempts: Array<{ approach: string; reason: string }>; filesChanged: string[];
  verification: Array<{ name: string; status: string }>; unresolved: string[]; remaining: string[];
};
export type TaskCheckpoint = {
  id: string; projectId: string; taskId: string; executionRunId?: string; previousCheckpointId?: string;
  status: TaskStatus; phase: TaskPhase; summary: string; state: CheckpointState; delta: Partial<CheckpointState>; createdAt: string;
};
export type ExecutionRun = {
  id: string; projectId: string; taskId?: string; agentSessionId?: string; provider: string;
  status: "PLANNED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED"; phase: TaskPhase;
  contextPacketId?: string; checkpointId?: string; rotationReason?: string; model?: string; startedAt: string; endedAt?: string;
};
export type AgentConnectionStatus = {
  provider: string; integrationMode: "ASSISTED" | "MANAGED"; status: "ACTIVE" | "IDLE" | "FAILED";
  lastSeenAt: string; activeRunCount: number;
};
export type AgentIntegrationStatus = {
  id: "codex" | "claude-code";
  name: "Codex" | "Claude Code";
  status: "CONNECTED" | "NEEDS_ATTENTION";
  detail?: "INSTALL_REQUIRED" | "MIGRATION_REQUIRED" | "CONFIGURATION_CONFLICT" | "HANDSHAKE_FAILED";
  mcp: "CONFIGURED" | "NOT_CONFIGURED";
  runtime: "READY" | "UNAVAILABLE";
  handshake: "OK" | "FAILED" | "NOT_CHECKED";
  integrationMode: "LIFECYCLE_MANAGED" | "MCP_ASSISTED" | "UNAVAILABLE";
  lifecycle: "CONFIGURED" | "NOT_CONFIGURED" | "UNSUPPORTED";
};
export type ContextPacketItem = {
  rank: number; sourceType: "TASK" | "CHECKPOINT" | "MEMORY"; sourceId: string; category: ContextCategory;
  priority: 0 | 1 | 2 | 3; score: number; estimatedTokens: number; reason: string; content: string; truncated: boolean;
};
export type ContextPacket = {
  id: string; projectId: string; taskId?: string; executionRunId?: string; version: number; currentRequest: string;
  provider?: string; maxTokens: number; estimatedTokens: number; retrievalRunId: string; packetHash: string;
  rendered: string; items: ContextPacketItem[]; createdAt: string;
};
export type CurrentContextResponse = { packet: ContextPacket | null };
export type ContextExplanation = {
  packet: ContextPacket; budgetByCategory: Record<string, { used: number; limit: number }>;
  excluded: Array<{ sourceId: string; category: ContextCategory; reason: string; estimatedTokens: number }>;
};
export type TaskRunContext = { run: ExecutionRun; packet?: ContextPacket };
export type ContextOsMetrics = {
  runs: number; successfulRuns: number; inputTokens: number; cachedInputTokens: number; outputTokens: number;
  contextPacketTokens: number; contextInjectionRatio: number; contextReductionRatio: number;
  contextReductionFactor: number; memoryHitRate: number; contextWasteRatio: number;
  sessionCarryCostProxy: number; contextCostPerSuccessfulTask: number; averageAssemblyLatencyMs: number;
};
export type LifecycleMetrics = {
  eventsAccepted: number; eventsSpooled: number; eventsReplayed: number; failOpenOutcomes: number;
  eventsByProvider: Record<string, number>; eventsByType: Record<string, number>;
  observationsPending: number; observationsProcessed: number; retrievalRuns: number;
  contextPacketsInjected: number; injectedEstimatedTokens: number;
  averageRetrievalLatencyMs: number; p95RetrievalLatencyMs: number;
  averageHookLatencyMs: number; maxHookLatencyMs: number;
  checkpointsCreated: number; compactionCheckpointsCreated: number; hookMemoriesPersisted: number;
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
export type ProjectMemoryConfig = {
  captureMode: "off" | "manual" | "summary";
  rawEventRetentionDays: number;
  contextBudgetMode: "auto" | "custom";
  defaultContextBudget: number;
};
export type BackupRestorePreview = { backup: BackupInspection; confirmation: string; warning: string };
export type BackupRestoreResult = { restored: BackupInspection; rollbackFileName: string | null };
export type MemoryPurgePreview = { memory: Pick<MemoryRecord, "id" | "summary" | "type" | "revisionCount">; confirmation: string; warning: string };
export type MemoryPurgeResult = { purgedMemoryIdHash: string };
export type TaskCheckpointListResponse = { items: TaskCheckpoint[] };
export type TaskRunListResponse = { items: ExecutionRun[] };
export type AgentConnectionListResponse = { items: AgentConnectionStatus[] };
export type AgentIntegrationListResponse = { items: AgentIntegrationStatus[] };
