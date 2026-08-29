import type { DatabaseSync } from "node:sqlite";
import { ContextOsService } from "../application/context-os-service.js";
import type { Memory, MemorySearchResult, RecordMemoryInput } from "../domain/memory.js";
import type { ContextOsPort } from "../domain/context-os.js";
import { ContextPacketRepository } from "./context-packet-repository.js";
import { ContextTelemetryRepository } from "./context-telemetry-repository.js";
import { ExecutionRepository } from "./execution-repository.js";
import { TaskCheckpointRepository } from "./task-checkpoint-repository.js";

export function createContextOs(
  database: DatabaseSync,
  dependencies: {
    search(projectId: string, query: string, limit: number): MemorySearchResult[];
    recent(projectId: string, limit: number): MemorySearchResult[];
    record(projectId: string, input: RecordMemoryInput): Memory;
  },
): ContextOsPort {
  return new ContextOsService(
    new TaskCheckpointRepository(database),
    new ContextPacketRepository(database),
    new ContextTelemetryRepository(database),
    new ExecutionRepository(database),
    { search: dependencies.search, recent: dependencies.recent },
    dependencies.record,
  );
}
