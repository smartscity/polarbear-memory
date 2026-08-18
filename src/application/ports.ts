import type { LifecycleStatus, Memory, MemorySearchResult, MemoryType, RecordMemoryInput, VerificationState } from "../domain/memory.js";
import type { EventEnvelope, StoredRawEvent } from "../domain/event.js";
import type { CompletionState, FileAnchor, MaintenanceAction, MemoryRelationType, MemoryRevision } from "../domain/lifecycle.js";

export interface MemoryStore {
  initializeProject(project: { id: string; name: string }): void;
  record(projectId: string, input: RecordMemoryInput): Memory;
  get(projectId: string, memoryId: string): Memory | undefined;
  update(projectId: string, memoryId: string, input: { summary: string; content: string; reason: string }): Memory;
  purge(projectId: string, memoryId: string, reason: string): { purgedMemoryIdHash: string };
  revisions(projectId: string, memoryId: string): MemoryRevision[];
  search(projectId: string, query: string, limit: number): MemorySearchResult[];
  recent(projectId: string, limit: number): MemorySearchResult[];
  list(projectId: string, options: { query?: string; status?: LifecycleStatus; type?: MemoryType; limit: number; offset: number }): Memory[];
  verify(projectId: string, memoryId: string, state: VerificationState, reason: string, actor?: "HUMAN_CLI" | "AGENT_MCP", evidence?: { anchors?: FileAnchor[]; checkedCommit?: string }): Memory;
  archive(projectId: string, memoryId: string, reason: string, actor?: "HUMAN_CLI" | "AGENT_MCP"): Memory;
  restore(projectId: string, memoryId: string, reason: string): Memory;
  complete(projectId: string, memoryId: string, state: Exclude<CompletionState, "OPEN">, reason: string, now?: Date): Memory;
  addRelation(projectId: string, sourceMemoryId: string, targetMemoryId: string, type: MemoryRelationType, reason: string): void;
  noteContextUsage(projectId: string, candidateIds: string[], selectedIds: string[], now: string): void;
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
