export const TASK_STATUSES = ["PLANNED", "ACTIVE", "BLOCKED", "VERIFYING", "DONE", "CANCELLED"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export const TASK_PHASES = [
  "DISCOVERY", "DESIGN", "IMPLEMENTATION", "DEBUGGING", "VERIFICATION", "REVIEW", "DOCUMENTATION",
] as const;
export type TaskPhase = typeof TASK_PHASES[number];

export const ROTATION_REASONS = [
  "TASK_CHANGED", "PHASE_CHANGED", "CONTEXT_BUDGET_EXCEEDED", "CONTEXT_POLLUTION",
  "COMPACTION_BOUNDARY", "IMPLEMENTATION_TO_REVIEW", "DEBUG_BRANCH_COMPLETED",
  "PROVIDER_ERROR_RECOVERY", "MANUAL_REQUEST", "MAX_RUNS_REACHED",
] as const;
export type RotationReason = typeof ROTATION_REASONS[number];

export type ContextCategory =
  | "OBJECTIVE" | "WORKING_MEMORY" | "CONSTRAINTS" | "DECISIONS"
  | "ARCHITECTURE" | "EPISODES" | "VERIFICATION" | "SEMANTIC" | "SOURCES";

export interface Task {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  status: TaskStatus;
  phase: TaskPhase;
  priority: number;
  parentTaskId?: string;
  lastCheckpointId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CheckpointState {
  changed: string[];
  learned: string[];
  decisionsAdded: string[];
  constraintsAdded: string[];
  failedAttempts: Array<{ approach: string; reason: string }>;
  filesChanged: string[];
  verification: Array<{ name: string; status: string }>;
  unresolved: string[];
  remaining: string[];
}

export interface Checkpoint {
  id: string;
  projectId: string;
  taskId: string;
  executionRunId?: string;
  previousCheckpointId?: string;
  status: TaskStatus;
  phase: TaskPhase;
  summary: string;
  state: CheckpointState;
  delta: Partial<CheckpointState>;
  createdAt: string;
}

export interface ContextPacketItem {
  rank: number;
  sourceType: "TASK" | "CHECKPOINT" | "MEMORY";
  sourceId: string;
  category: ContextCategory;
  priority: 0 | 1 | 2 | 3;
  score: number;
  estimatedTokens: number;
  reason: string;
  content: string;
  truncated: boolean;
}

export interface ContextPacket {
  id: string;
  projectId: string;
  taskId?: string;
  executionRunId?: string;
  version: number;
  currentRequest: string;
  provider?: string;
  maxTokens: number;
  estimatedTokens: number;
  retrievalRunId: string;
  packetHash: string;
  rendered: string;
  items: ContextPacketItem[];
  createdAt: string;
}

export type ContextDeliveryStatus = "BUILT" | "DELIVERED" | "FAILED";
export type ContextDeliveryMode = "ASSISTED" | "MANAGED";

export interface ContextReceipt {
  packetId: string;
  projectId: string;
  taskId?: string;
  checkpointId?: string;
  provider?: string;
  integrationMode?: ContextDeliveryMode;
  deliveryPoint?: string;
  status: ContextDeliveryStatus;
  candidateCount: number;
  selectedCount: number;
  selectedMemoryCount: number;
  sourceCounts: Record<ContextPacketItem["sourceType"], number>;
  estimatedTokens: number;
  builtAt: string;
  deliveredAt?: string;
  failureCode?: string;
  failureReason?: string;
}

export interface ContextExplanation {
  packet: ContextPacket;
  receipt: ContextReceipt;
  budgetByCategory: Record<string, { used: number; limit: number }>;
  excluded: Array<{ sourceId: string; category: ContextCategory; reason: string; estimatedTokens: number }>;
}

export interface Observation {
  id: string;
  projectId: string;
  taskId?: string;
  executionRunId?: string;
  agentSessionId?: string;
  provider: string;
  eventType: string;
  payload: Record<string, unknown>;
  artifactRefs: string[];
  estimatedTokens: number;
  importance: number;
  occurredAt: string;
}

export interface AgentSession {
  id: string;
  projectId: string;
  provider: string;
  integrationMode: "ASSISTED" | "MANAGED";
  status: "OPEN" | "ENDED" | "FAILED";
  externalSessionRefHash?: string;
  estimatedContextTokens: number;
  turnCount: number;
  compactCount: number;
  taskAffinity: number;
  startedAt: string;
  endedAt?: string;
  updatedAt: string;
}

export interface ExecutionRun {
  id: string;
  projectId: string;
  taskId?: string;
  agentSessionId?: string;
  provider: string;
  status: "PLANNED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  phase: TaskPhase;
  contextPacketId?: string;
  checkpointId?: string;
  rotationReason?: RotationReason;
  model?: string;
  startedAt: string;
  endedAt?: string;
}

export interface AgentConnectionStatus {
  provider: string;
  integrationMode: "ASSISTED" | "MANAGED";
  status: "ACTIVE" | "IDLE" | "FAILED";
  lastSeenAt: string;
  activeRunCount: number;
}

export interface TaskRunContext {
  run: ExecutionRun;
  packet?: ContextPacket;
}

export interface UsageLedgerEntry {
  id: string;
  projectId: string;
  taskId?: string;
  executionRunId?: string;
  provider: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  contextPacketTokens: number;
  usefulContextTokens: number;
  successful: boolean;
  createdAt: string;
}

export interface ContextOsMetrics {
  runs: number;
  successfulRuns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  contextPacketTokens: number;
  contextInjectionRatio: number;
  contextReductionRatio: number;
  contextReductionFactor: number;
  memoryHitRate: number;
  contextWasteRatio: number;
  sessionCarryCostProxy: number;
  contextCostPerSuccessfulTask: number;
  averageAssemblyLatencyMs: number;
}

export type LifecycleMetricOutcome = "ACCEPTED" | "REJECTED" | "SPOOLED" | "REPLAYED" | "FAIL_OPEN";

export interface LifecycleMetrics {
  eventsAccepted: number;
  eventsSpooled: number;
  eventsReplayed: number;
  failOpenOutcomes: number;
  eventsByProvider: Record<string, number>;
  eventsByType: Record<string, number>;
  observationsPending: number;
  observationsProcessed: number;
  retrievalRuns: number;
  contextPacketsBuilt: number;
  contextPacketsDelivered: number;
  contextDeliveryFailures: number;
  deliveredEstimatedTokens: number;
  contextPacketsInjected: number;
  injectedEstimatedTokens: number;
  averageRetrievalLatencyMs: number;
  p95RetrievalLatencyMs: number;
  averageHookLatencyMs: number;
  maxHookLatencyMs: number;
  checkpointsCreated: number;
  compactionCheckpointsCreated: number;
  hookMemoriesPersisted: number;
}

export interface RotationContext {
  taskChanged?: boolean;
  phaseChanged?: boolean;
  implementationToReview?: boolean;
  debugBranchCompleted?: boolean;
  providerError?: boolean;
  manualRequest?: boolean;
  compactionBoundary?: boolean;
  estimatedSessionContextTokens?: number;
  sessionTurnCount?: number;
  compactCount?: number;
  currentTaskAffinity?: number;
  irrelevantContextRatio?: number;
  executionRunCount?: number;
}

export interface RotationDecision {
  rotate: boolean;
  reason?: RotationReason;
  checkpointRequired: boolean;
}

export interface ContextOsPort {
  createTask(projectId: string, input: { title: string; objective: string; phase?: TaskPhase; priority?: number; parentTaskId?: string }): Task;
  getTask(projectId: string, taskId: string): Task | undefined;
  listTasks(projectId: string, status?: TaskStatus): Task[];
  latestCheckpoint(projectId: string, taskId: string): Checkpoint | undefined;
  listCheckpoints(projectId: string, taskId: string, limit?: number): Checkpoint[];
  checkpoint(projectId: string, input: { taskId: string; executionRunId?: string; status: TaskStatus; phase: TaskPhase; summary: string; state: CheckpointState; delta?: Partial<CheckpointState>; idempotencyKey?: string }): Checkpoint;
  listTaskRuns(projectId: string, taskId: string, limit?: number): ExecutionRun[];
  getTaskRunContext(projectId: string, taskId: string, runId: string): TaskRunContext;
  listAgentConnections(projectId: string): AgentConnectionStatus[];
  startExecution(projectId: string, input: { taskId?: string; provider: string; phase: TaskPhase; externalSessionRef?: string; integrationMode: "ASSISTED" | "MANAGED"; contextPacketId?: string; model?: string; rotationReason?: RotationReason }): ExecutionRun;
  finishExecution(projectId: string, runId: string, input: { status: "SUCCEEDED" | "FAILED" | "CANCELLED"; externalSessionRef?: string }): ExecutionRun;
  buildContext(projectId: string, input: { currentRequest: string; taskId?: string; maxTokens?: number; provider?: string }): ContextPacket;
  currentContext(projectId: string): ContextPacket | undefined;
  explainContext(projectId: string, packetId: string): ContextExplanation;
  contextReceipt(projectId: string, packetId: string): ContextReceipt;
  recordContextDelivery(projectId: string, packetId: string, input: {
    provider: string;
    integrationMode: ContextDeliveryMode;
    deliveryPoint: string;
    status: "DELIVERED" | "FAILED";
    sourceFingerprint: string;
    failureCode?: string;
    failureReason?: string;
  }): ContextReceipt;
  recordObservation(projectId: string, input: Omit<Observation, "id" | "projectId"> & { sourceFingerprint?: string }): Observation;
  distill(projectId: string, limit?: number, sessionRefHash?: string): { observations: number; candidates: number; recorded: number };
  recordUsage(projectId: string, input: Omit<UsageLedgerEntry, "id" | "projectId" | "createdAt">): UsageLedgerEntry;
  metrics(projectId: string, taskId?: string): ContextOsMetrics;
  recordLifecycleMetric(projectId: string, input: { provider: string; eventType: string; outcome: LifecycleMetricOutcome; latencyMs?: number }): void;
  lifecycleMetrics(projectId: string): LifecycleMetrics;
  decideRotation(input: RotationContext): RotationDecision;
}

export function emptyCheckpointState(): CheckpointState {
  return {
    changed: [], learned: [], decisionsAdded: [], constraintsAdded: [], failedAttempts: [],
    filesChanged: [], verification: [], unresolved: [], remaining: [],
  };
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 500 || value.some((item) => typeof item !== "string")) {
    throw new Error(`Checkpoint field ${field} must be an array of at most 500 strings.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

export function validateCheckpointState(value: unknown): CheckpointState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Checkpoint state must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  const failedAttempts = input.failedAttempts;
  if (!Array.isArray(failedAttempts) || failedAttempts.length > 500 || failedAttempts.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    const entry = item as Record<string, unknown>;
    return typeof entry.approach !== "string" || typeof entry.reason !== "string";
  })) {
    throw new Error("Checkpoint field failedAttempts must contain at most 500 approach/reason objects.");
  }
  const verification = input.verification;
  if (!Array.isArray(verification) || verification.length > 500 || verification.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    const entry = item as Record<string, unknown>;
    return typeof entry.name !== "string" || typeof entry.status !== "string";
  })) {
    throw new Error("Checkpoint field verification must contain at most 500 name/status objects.");
  }
  return {
    changed: stringList(input.changed, "changed"),
    learned: stringList(input.learned, "learned"),
    decisionsAdded: stringList(input.decisionsAdded, "decisionsAdded"),
    constraintsAdded: stringList(input.constraintsAdded, "constraintsAdded"),
    failedAttempts: failedAttempts.map((item) => {
      const entry = item as { approach: string; reason: string };
      return { approach: entry.approach.trim(), reason: entry.reason.trim() };
    }),
    filesChanged: stringList(input.filesChanged, "filesChanged"),
    verification: verification.map((item) => {
      const entry = item as { name: string; status: string };
      return { name: entry.name.trim(), status: entry.status.trim() };
    }),
    unresolved: stringList(input.unresolved, "unresolved"),
    remaining: stringList(input.remaining, "remaining"),
  };
}
