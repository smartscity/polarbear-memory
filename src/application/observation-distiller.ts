import type { Observation } from "../domain/context-os.js";
import type { Memory, RecordMemoryInput } from "../domain/memory.js";
import type { ContextTelemetryRepository } from "../storage/context-telemetry-repository.js";
import { extractCandidates } from "./finalization.js";

export class ObservationDistiller {
  readonly #telemetry: ContextTelemetryRepository;
  readonly #record: (projectId: string, input: RecordMemoryInput) => Memory;

  constructor(
    telemetry: ContextTelemetryRepository,
    record: (projectId: string, input: RecordMemoryInput) => Memory,
  ) {
    this.#telemetry = telemetry;
    this.#record = record;
  }

  distill(projectId: string, limit = 200): { observations: number; candidates: number; recorded: number } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Distillation limit must be between 1 and 1000.");
    const observations = this.#telemetry.pendingObservations(projectId, limit);
    let candidates = 0;
    let recorded = 0;
    for (const observation of observations) {
      for (const candidate of this.#candidates(observation)) {
        candidates += 1;
        this.#record(projectId, {
          ...candidate, sourceType: "HOOK",
          ...(observation.taskId ? { scopeKind: "TASK", scopeRef: observation.taskId } : {}),
        });
        recorded += 1;
      }
    }
    this.#telemetry.markDistilled(projectId, observations.map((observation) => observation.id));
    return { observations: observations.length, candidates, recorded };
  }

  #candidates(observation: Observation): RecordMemoryInput[] {
    const text = [observation.payload.lastAssistantMessage, observation.payload.prompt]
      .filter((value): value is string => typeof value === "string").join("\n");
    return text ? extractCandidates(text) : [];
  }
}
