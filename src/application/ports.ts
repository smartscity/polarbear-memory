import type { Memory, MemorySearchResult, RecordMemoryInput } from "../domain/memory.js";

export interface MemoryStore {
  initializeProject(project: { id: string; name: string }): void;
  record(projectId: string, input: RecordMemoryInput): Memory;
  get(projectId: string, memoryId: string): Memory | undefined;
  search(projectId: string, query: string, limit: number): MemorySearchResult[];
  recent(projectId: string, limit: number): MemorySearchResult[];
  status(projectId: string): Record<string, number>;
  rebuildSearchIndex(): void;
  backup(destination: string): Promise<number>;
  close(): void;
}
