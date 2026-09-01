import type { LifecycleStatus, Memory, MemorySearchResult, MemoryType, RecordMemoryInput, VerificationState } from "../domain/memory.js";
import type { EventEnvelope, StoredRawEvent } from "../domain/event.js";
import type { CompletionState, FileAnchor, MaintenanceAction, MemoryRelationType, MemoryRevision } from "../domain/lifecycle.js";
import type {
  AgentKind,
  CaptureStatus,
  Entity,
  EntityKind,
  EntityRole,
  Episode,
  EpisodeType,
  Evidence,
  EvidenceRole,
  EvidenceType,
  RetentionClass,
  Session,
  TrustLevel,
} from "../domain/knowledge.js";
import type { ContextOsPort } from "../domain/context-os.js";

export interface TokenSavingsStats {
  contextPackCount: number;
  candidateCount: number;
  selectedCount: number;
  baselineTokens: number;
  contextTokens: number;
  estimatedSavedTokens: number;
  measurementStartedAt: string;
  lastContextAt?: string;
  resetCount: number;
}

export interface MemoryStore {
  initializeProject(project: { id: string; name: string }): void;
  upsertSession(projectId: string, input: {
    id?: string;
    agentKind: AgentKind;
    externalSessionRefHash?: string;
    branchName?: string;
    headStart?: string;
    startedAt?: string;
    captureStatus?: CaptureStatus;
  }): Session;
  endSession(projectId: string, sessionId: string, input: { endedAt?: string; headEnd?: string; captureStatus?: CaptureStatus }): Session;
  recordEpisode(projectId: string, input: {
    id?: string;
    sessionId?: string;
    type: EpisodeType;
    occurredAt?: string;
    sourceDigest: string;
    summary: string;
    payloadRef?: string;
    retentionClass?: RetentionClass;
  }): Episode;
  recordEvidence(projectId: string, input: {
    id?: string;
    episodeId?: string;
    type: EvidenceType;
    sourceRef?: string;
    digest: string;
    observedAt?: string;
    commitSha?: string;
    trustLevel?: TrustLevel;
    metadata?: Record<string, string | number | boolean | null>;
  }): Evidence;
  linkEvidence(projectId: string, memoryId: string, evidenceId: string, role: EvidenceRole, confidence?: number): Memory;
  upsertEntity(projectId: string, input: {
    id?: string;
    kind: EntityKind;
    canonicalKey: string;
    displayName: string;
    metadata?: Record<string, string | number | boolean | null>;
  }): Entity;
  linkEntity(projectId: string, memoryId: string, entityId: string, role: EntityRole, confidence?: number): Memory;
  record(projectId: string, input: RecordMemoryInput): Memory;
  get(projectId: string, memoryId: string): Memory | undefined;
  update(projectId: string, memoryId: string, input: { summary: string; content: string; reason: string }): Memory;
  purge(projectId: string, memoryId: string, reason: string): { purgedMemoryIdHash: string };
  revisions(projectId: string, memoryId: string): MemoryRevision[];
  search(projectId: string, query: string, limit: number): MemorySearchResult[];
  recent(projectId: string, limit: number): MemorySearchResult[];
  list(projectId: string, options: { query?: string; status?: LifecycleStatus; type?: MemoryType; limit: number; offset: number }): Memory[];
  verify(projectId: string, memoryId: string, state: VerificationState, reason: string, actor?: "HUMAN_CLI" | "AGENT_MCP", evidence?: { anchors?: FileAnchor[]; checkedCommit?: string }): Memory;
  reject(projectId: string, memoryId: string, reason: string): Memory;
  archive(projectId: string, memoryId: string, reason: string, actor?: "HUMAN_CLI" | "AGENT_MCP"): Memory;
  restore(projectId: string, memoryId: string, reason: string): Memory;
  complete(projectId: string, memoryId: string, state: Exclude<CompletionState, "OPEN">, reason: string, now?: Date): Memory;
  addRelation(projectId: string, sourceMemoryId: string, targetMemoryId: string, type: MemoryRelationType, reason: string): void;
  noteContextUsage(
    projectId: string,
    candidateIds: string[],
    selectedIds: string[],
    tokens: { baseline: number; context: number },
    now: string,
  ): void;
  tokenSavings(projectId: string): TokenSavingsStats;
  resetTokenSavings(projectId: string, now: string): TokenSavingsStats;
  contextOs(): ContextOsPort;
  noteFeedback(projectId: string, memoryId: string, useful: boolean, reason: string): Memory;
  maintenanceCursor(projectId: string): string | undefined;
  maintenanceCandidates(projectId: string, limit: number, targetCommit?: string, archiveBefore?: string, now?: string, changedPaths?: string[]): Memory[];
  countExpiredRawEvents(projectId: string, now: string): number;
  applyMaintenance(projectId: string, actions: MaintenanceAction[], cursorCommit: string | undefined, now: string, policyVersion: string, assessorVersion: string): number;
  ingestRawEvent(event: EventEnvelope): boolean;
  unprocessedRawEvents(projectId: string, sessionRefHash: string): StoredRawEvent[];
  pendingEndedSessions(projectId: string): string[];
  markRawEventProcessed(projectId: string, eventId: string, processedAt: string): void;
  deleteExpiredRawEvents(projectId: string, now: string): number;
  status(projectId: string): Record<string, number>;
  rebuildSearchIndex(): void;
  backup(destination: string): Promise<number>;
  close(): void;
}

export type ContextMemoryPort = Pick<MemoryStore, "search" | "recent" | "noteContextUsage">;
export type FinalizationMemoryPort = Pick<MemoryStore,
  "unprocessedRawEvents" | "record" | "markRawEventProcessed" | "deleteExpiredRawEvents">;
export type MaintenanceMemoryPort = Pick<MemoryStore,
  "maintenanceCursor" | "maintenanceCandidates" | "countExpiredRawEvents" | "applyMaintenance">;
export type BenchmarkMemoryPort = Pick<MemoryStore, "record" | "complete" | "status"> & ContextMemoryPort;
