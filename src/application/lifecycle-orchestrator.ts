import type { AgentLifecycleEvent, AgentLifecycleOutcome } from "../domain/agent-lifecycle.js";
import type { ContextOsPort, Task } from "../domain/context-os.js";

const CONTEXT_EVENTS = new Set(["SESSION_STARTED", "USER_PROMPT_SUBMITTED"]);
const TURN_BOUNDARIES = new Set(["TURN_COMPLETED", "TURN_FAILED", "SESSION_ENDED"]);

function artifactRefs(payload: Record<string, string | boolean>): string[] {
  if (typeof payload.artifactRefs !== "string") return [];
  try {
    const parsed = JSON.parse(payload.artifactRefs) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === "string"
      && item.length > 0 && item.length <= 1_024 && !item.startsWith("/") && !item.split("/").includes("..")))].slice(0, 20);
  } catch {
    return [];
  }
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
    const resolution = this.#contextOs.resolveTaskAffinity(this.#projectId, {
      ...(event.preferredTaskId ? { preferredTaskId: event.preferredTaskId } : {}),
      sessionRefHash: event.sessionRefHash,
      ...(event.currentRequest ? { currentRequest: event.currentRequest } : {}),
      createIfMissing: event.type === "USER_PROMPT_SUBMITTED",
    });
    const resolvedTask = resolution.task;
    this.#contextOs.recordObservation(this.#projectId, {
      ...(resolvedTask ? { taskId: resolvedTask.id } : {}),
      provider: event.provider,
      eventType: event.type,
      payload: { ...event.payload, sessionRefHash: event.sessionRefHash },
      artifactRefs: artifactRefs(event.payload),
      estimatedTokens: Math.ceil(Buffer.byteLength(JSON.stringify(event.payload), "utf8") / 4),
      importance: this.#importance(event.type),
      occurredAt: event.occurredAt,
      sourceFingerprint: event.id,
    });

    const checkpoint = resolvedTask && (event.type === "BEFORE_COMPACTION" || TURN_BOUNDARIES.has(event.type))
      ? this.#contextOs.checkpointLifecycle(this.#projectId, {
          taskId: resolvedTask.id,
          sessionRefHash: event.sessionRefHash,
          boundary: event.type as "TURN_COMPLETED" | "TURN_FAILED" | "BEFORE_COMPACTION" | "SESSION_ENDED",
          idempotencyKey: event.id,
        })
      : undefined;
    const task = checkpoint
      ? this.#contextOs.getTask(this.#projectId, checkpoint.taskId) ?? resolvedTask
      : resolvedTask;
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

  #importance(type: AgentLifecycleEvent["type"]): number {
    if (type === "BEFORE_COMPACTION" || type === "SESSION_ENDED") return 900;
    if (type === "TURN_COMPLETED" || type === "TURN_FAILED") return 800;
    if (type === "USER_PROMPT_SUBMITTED" || type === "SESSION_STARTED") return 600;
    return 400;
  }
}
