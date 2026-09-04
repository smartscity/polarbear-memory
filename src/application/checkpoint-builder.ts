import type { Checkpoint, CheckpointState, Observation, Task, TaskStatus } from "../domain/context-os.js";
import type { ContextTelemetryRepository } from "../storage/context-telemetry-repository.js";
import type { TaskCheckpointRepository } from "../storage/task-checkpoint-repository.js";
import { emptyCheckpointState } from "../domain/context-os.js";
import { extractCandidates } from "./finalization.js";

function unique(values: string[], limit = 500): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function mergeState(base: CheckpointState, delta: Partial<CheckpointState>, completedRemaining: string[]): CheckpointState {
  const failedAttempts = [...base.failedAttempts, ...(delta.failedAttempts ?? [])];
  const verification = [...base.verification, ...(delta.verification ?? [])];
  return {
    changed: unique([...base.changed, ...(delta.changed ?? [])]),
    learned: unique([...base.learned, ...(delta.learned ?? [])]),
    decisionsAdded: unique([...base.decisionsAdded, ...(delta.decisionsAdded ?? [])]),
    constraintsAdded: unique([...base.constraintsAdded, ...(delta.constraintsAdded ?? [])]),
    failedAttempts: failedAttempts.filter((item, index) => failedAttempts.findIndex((candidate) =>
      candidate.approach === item.approach && candidate.reason === item.reason) === index).slice(0, 500),
    filesChanged: unique([...base.filesChanged, ...(delta.filesChanged ?? [])]),
    verification: verification.filter((item, index) => verification.findIndex((candidate) =>
      candidate.name === item.name && candidate.status === item.status) === index).slice(0, 500),
    unresolved: unique([...base.unresolved, ...(delta.unresolved ?? [])]),
    remaining: unique([...(delta.remaining ?? []), ...base.remaining])
      .filter((item) => !completedRemaining.includes(item)),
  };
}

function stateDelta(previous: CheckpointState | undefined, current: CheckpointState): Partial<CheckpointState> {
  if (!previous) return current;
  const addedStrings = (next: string[], before: string[]) => next.filter((item) => !before.includes(item));
  const addedObjects = <T>(next: T[], before: T[]) => {
    const existing = new Set(before.map((item) => JSON.stringify(item)));
    return next.filter((item) => !existing.has(JSON.stringify(item)));
  };
  return {
    changed: addedStrings(current.changed, previous.changed),
    learned: addedStrings(current.learned, previous.learned),
    decisionsAdded: addedStrings(current.decisionsAdded, previous.decisionsAdded),
    constraintsAdded: addedStrings(current.constraintsAdded, previous.constraintsAdded),
    failedAttempts: addedObjects(current.failedAttempts, previous.failedAttempts),
    filesChanged: addedStrings(current.filesChanged, previous.filesChanged),
    verification: addedObjects(current.verification, previous.verification),
    unresolved: addedStrings(current.unresolved, previous.unresolved),
    remaining: current.remaining.filter((item) => !previous.remaining.includes(item)),
  };
}

function short(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().slice(0, 512);
}

function observationDelta(observations: Observation[], task: Task): {
  delta: Partial<CheckpointState>; completedRemaining: string[]; completionStatus?: "DONE" | "CANCELLED";
} {
  const changed: string[] = [];
  const learned: string[] = [];
  const decisionsAdded: string[] = [];
  const constraintsAdded: string[] = [];
  const failedAttempts: CheckpointState["failedAttempts"] = [];
  const filesChanged: string[] = [];
  const verification: CheckpointState["verification"] = [];
  const unresolved: string[] = [];
  const remaining: string[] = [];
  const completedRemaining: string[] = [];
  let completionStatus: "DONE" | "CANCELLED" | undefined;

  for (const observation of observations) {
    const label = short(observation.payload.toolName ?? observation.payload.itemType, "Agent operation");
    if (observation.eventType === "TOOL_COMPLETED") {
      filesChanged.push(...observation.artifactRefs);
      if (observation.artifactRefs.length > 0) changed.push(`Updated ${observation.artifactRefs.join(", ")}`);
      if (/test|check|lint|build|verify/iu.test(label)) verification.push({ name: label, status: "PASSED" });
    }
    if (observation.eventType === "TOOL_FAILED") {
      const reason = short(observation.payload.errorSummary ?? observation.payload.error, "The operation failed.");
      failedAttempts.push({ approach: label, reason });
      unresolved.push(`${label} failed: ${reason}`);
      if (/test|check|lint|build|verify/iu.test(label)) verification.push({ name: label, status: "FAILED" });
    }
    const message = typeof observation.payload.lastAssistantMessage === "string"
      ? observation.payload.lastAssistantMessage : "";
    for (const candidate of extractCandidates(message)) {
      if (candidate.type === "DECISION") decisionsAdded.push(candidate.summary);
      else if (candidate.type === "CONSTRAINT") constraintsAdded.push(candidate.summary);
      else if (candidate.type === "PITFALL") learned.push(candidate.summary);
      else if (candidate.type === "TASK_STATE") {
        changed.push(candidate.summary);
        if (candidate.completionState === "COMPLETED") completionStatus = "DONE";
        if (candidate.completionState === "CANCELLED") completionStatus = "CANCELLED";
      } else if (candidate.type === "TODO") {
        if (candidate.completionState) completedRemaining.push(candidate.summary);
        else remaining.push(candidate.summary);
      }
    }
  }
  return {
    delta: {
      changed, learned, decisionsAdded, constraintsAdded, failedAttempts, filesChanged, verification, unresolved,
      remaining: remaining.length > 0 ? remaining : [task.objective],
    },
    completedRemaining,
    ...(completionStatus ? { completionStatus } : {}),
  };
}

export class CheckpointBuilder {
  readonly #tasks: TaskCheckpointRepository;
  readonly #telemetry: ContextTelemetryRepository;

  constructor(tasks: TaskCheckpointRepository, telemetry: ContextTelemetryRepository) {
    this.#tasks = tasks;
    this.#telemetry = telemetry;
  }

  build(projectId: string, input: {
    taskId: string; sessionRefHash: string; boundary: "TURN_COMPLETED" | "TURN_FAILED" | "BEFORE_COMPACTION" | "SESSION_ENDED";
    idempotencyKey: string;
  }): Checkpoint {
    const task = this.#tasks.requireTask(projectId, input.taskId);
    const previous = this.#tasks.latestCheckpoint(projectId, task.id);
    const observations = this.#telemetry.observationsForSession(projectId, task.id, input.sessionRefHash);
    const base = previous?.state ?? { ...emptyCheckpointState(), remaining: [task.objective] };
    const derived = observationDelta(observations, task);
    const state = mergeState(base, derived.delta, derived.completedRemaining);
    if (derived.completionStatus) state.remaining = [];
    const status: TaskStatus = input.boundary === "TURN_FAILED" ? "BLOCKED"
      : derived.completionStatus ?? (task.status === "PLANNED" ? "ACTIVE" : task.status);
    const phase = input.boundary === "TURN_FAILED" ? "DEBUGGING" : task.phase;
    if (previous && previous.status === status && previous.phase === phase
      && JSON.stringify(previous.state) === JSON.stringify(state)) return previous;
    return this.#tasks.checkpoint(projectId, {
      taskId: task.id,
      status,
      phase,
      summary: input.boundary === "BEFORE_COMPACTION"
        ? "Compaction boundary checkpoint (automatic)."
        : `Automatic ${input.boundary.toLocaleLowerCase().replaceAll("_", " ")} checkpoint.`,
      state,
      delta: stateDelta(previous?.state, state),
      idempotencyKey: input.idempotencyKey,
    });
  }
}
