import type { AgentLifecycleEvent, AgentLifecycleOutcome } from "../domain/agent-lifecycle.js";
import { emptyCheckpointState, type CheckpointState, type ContextOsPort, type Task } from "../domain/context-os.js";

const CONTINUABLE_TASK_STATUSES = new Set(["ACTIVE", "VERIFYING", "BLOCKED", "PLANNED"]);
const CONTEXT_EVENTS = new Set(["SESSION_STARTED", "USER_PROMPT_SUBMITTED"]);
const TURN_BOUNDARIES = new Set(["TURN_COMPLETED", "TURN_FAILED", "SESSION_ENDED"]);

function continuationState(task: Task, previous?: CheckpointState): CheckpointState {
  const state = previous ?? emptyCheckpointState();
  return {
    changed: [...state.changed],
    learned: [...state.learned],
    decisionsAdded: [...state.decisionsAdded],
    constraintsAdded: [...state.constraintsAdded],
    failedAttempts: state.failedAttempts.map((item) => ({ ...item })),
    filesChanged: [...state.filesChanged],
    verification: state.verification.map((item) => ({ ...item })),
    unresolved: [...state.unresolved],
    remaining: state.remaining.length > 0 ? [...state.remaining] : [task.objective],
  };
}

export class LifecycleOrchestrator {
  readonly #contextOs: ContextOsPort;
  readonly #projectId: string;

  constructor(contextOs: ContextOsPort, projectId: string) {
    this.#contextOs = contextOs;
    this.#projectId = projectId;
  }

  handle(event: AgentLifecycleEvent): AgentLifecycleOutcome {
    const startedAt = Date.now();
    try {
      const outcome = this.#handle(event);
      this.recordMetric(event, "ACCEPTED", Date.now() - startedAt);
      return outcome;
    } catch (error) {
      this.recordMetric(event, "FAIL_OPEN", Date.now() - startedAt);
      throw error;
    }
  }

  #handle(event: AgentLifecycleEvent): AgentLifecycleOutcome {
    const task = this.#resolveTask(event.preferredTaskId);
    this.#contextOs.recordObservation(this.#projectId, {
      ...(task ? { taskId: task.id } : {}),
      provider: event.provider,
      eventType: event.type,
      payload: { ...event.payload, sessionRefHash: event.sessionRefHash },
      artifactRefs: [],
      estimatedTokens: Math.ceil(Buffer.byteLength(JSON.stringify(event.payload), "utf8") / 4),
      importance: this.#importance(event.type),
      occurredAt: event.occurredAt,
      sourceFingerprint: event.id,
    });

    const checkpoint = task && event.type === "BEFORE_COMPACTION"
      ? this.#checkpoint(task, event.id)
      : undefined;
    const distilled = TURN_BOUNDARIES.has(event.type)
      ? this.#contextOs.distill(this.#projectId, 200, event.sessionRefHash)
      : { observations: 0, candidates: 0, recorded: 0 };
    const contextPacket = CONTEXT_EVENTS.has(event.type)
      ? this.#context(task, event)
      : undefined;

    return {
      accepted: true,
      ...(task ? { task } : {}),
      ...(contextPacket ? { contextPacket } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      observations: distilled.observations,
      candidates: distilled.candidates,
      persisted: distilled.recorded,
    };
  }

  recordMetric(
    event: AgentLifecycleEvent,
    outcome: Parameters<ContextOsPort["recordLifecycleMetric"]>[1]["outcome"],
    latencyMs = 0,
  ): void {
    try {
      this.#contextOs.recordLifecycleMetric(this.#projectId, {
        provider: event.provider, eventType: event.type, outcome, latencyMs,
      });
    } catch {
      // Metrics are diagnostic and must never change lifecycle behavior.
    }
  }

  recordContextDelivery(packetId: string, input: Parameters<ContextOsPort["recordContextDelivery"]>[2]) {
    return this.#contextOs.recordContextDelivery(this.#projectId, packetId, input);
  }

  #resolveTask(preferredTaskId?: string): Task | undefined {
    if (preferredTaskId) {
      const preferred = this.#contextOs.getTask(this.#projectId, preferredTaskId);
      if (preferred && CONTINUABLE_TASK_STATUSES.has(preferred.status)) return preferred;
    }
    return this.#contextOs.listTasks(this.#projectId)
      .find((task) => CONTINUABLE_TASK_STATUSES.has(task.status));
  }

  #context(task: Task | undefined, event: AgentLifecycleEvent) {
    const currentRequest = event.type === "USER_PROMPT_SUBMITTED"
      ? event.currentRequest?.trim()
      : "Start or resume the active project work.";
    if (!currentRequest) return undefined;
    return this.#contextOs.buildContext(this.#projectId, {
      ...(task ? { taskId: task.id } : {}),
      currentRequest,
      provider: event.provider,
      ...(event.contextBudget === undefined ? {} : { maxTokens: event.contextBudget }),
    });
  }

  #checkpoint(task: Task, idempotencyKey: string) {
    const previous = this.#contextOs.latestCheckpoint(this.#projectId, task.id);
    return this.#contextOs.checkpoint(this.#projectId, {
      taskId: task.id,
      status: task.status,
      phase: task.phase,
      summary: previous
        ? `Compaction checkpoint: ${previous.summary}`
        : "Compaction boundary checkpoint with the active objective and known continuation state.",
      state: continuationState(task, previous?.state),
      idempotencyKey,
    });
  }

  #importance(type: AgentLifecycleEvent["type"]): number {
    if (type === "BEFORE_COMPACTION" || type === "SESSION_ENDED") return 900;
    if (type === "TURN_COMPLETED" || type === "TURN_FAILED") return 800;
    if (type === "USER_PROMPT_SUBMITTED" || type === "SESSION_STARTED") return 600;
    return 400;
  }
}
