import type { Task, TaskAffinityResolution } from "../domain/context-os.js";
import type { ContextTelemetryRepository } from "../storage/context-telemetry-repository.js";
import type { TaskCheckpointRepository } from "../storage/task-checkpoint-repository.js";

const CONTINUABLE = new Set(["PLANNED", "ACTIVE", "BLOCKED", "VERIFYING"]);
const REQUEST_STOP_TERMS = new Set(["and", "continue", "for", "from", "that", "the", "this", "with", "work"]);

function requestTerms(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])]
    .filter((term) => !REQUEST_STOP_TERMS.has(term)).slice(0, 50);
}

function requestScore(task: Task, terms: string[]): number {
  const title = task.title.toLocaleLowerCase();
  const objective = task.objective.toLocaleLowerCase();
  return terms.reduce((score, term) => score + (title.includes(term) ? 3 : 0) + (objective.includes(term) ? 1 : 0), 0);
}

function boundedTitle(request: string): string {
  const firstLine = request.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "Active project work";
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 119)}…`;
}

export class TaskAffinityResolver {
  readonly #tasks: TaskCheckpointRepository;
  readonly #telemetry: ContextTelemetryRepository;

  constructor(tasks: TaskCheckpointRepository, telemetry: ContextTelemetryRepository) {
    this.#tasks = tasks;
    this.#telemetry = telemetry;
  }

  resolve(projectId: string, input: {
    preferredTaskId?: string; sessionRefHash: string; currentRequest?: string; createIfMissing?: boolean;
  }): TaskAffinityResolution {
    if (input.preferredTaskId) {
      const explicit = this.#tasks.getTask(projectId, input.preferredTaskId);
      if (!explicit) throw new Error(`Preferred task not found: ${input.preferredTaskId}`);
      if (!CONTINUABLE.has(explicit.status)) throw new Error(`Preferred task is not continuable: ${input.preferredTaskId}`);
      return { task: explicit, reason: "EXPLICIT", ambiguousTaskIds: [] };
    }

    const sessionTaskId = this.#telemetry.latestTaskIdForSession(projectId, input.sessionRefHash);
    const sessionTask = sessionTaskId ? this.#tasks.getTask(projectId, sessionTaskId) : undefined;
    if (sessionTask && CONTINUABLE.has(sessionTask.status)) {
      return { task: sessionTask, reason: "SESSION", ambiguousTaskIds: [] };
    }

    const tasks = this.#tasks.listTasks(projectId).filter((task) => CONTINUABLE.has(task.status));
    if (tasks.length === 1) return { task: tasks[0]!, reason: "ONLY_CONTINUABLE", ambiguousTaskIds: [] };

    const request = input.currentRequest?.trim() ?? "";
    if (tasks.length > 1 && request) {
      const terms = requestTerms(request);
      const ranked = tasks.map((task) => ({ task, score: requestScore(task, terms) }))
        .sort((left, right) => right.score - left.score || left.task.id.localeCompare(right.task.id));
      if (ranked[0] && ranked[0].score > 0 && ranked[0].score > (ranked[1]?.score ?? 0)) {
        return { task: ranked[0].task, reason: "REQUEST_MATCH", ambiguousTaskIds: [] };
      }
      return { reason: "AMBIGUOUS", ambiguousTaskIds: tasks.map((task) => task.id) };
    }

    if (tasks.length > 1) return { reason: "AMBIGUOUS", ambiguousTaskIds: tasks.map((task) => task.id) };
    if (request && input.createIfMissing) {
      const title = boundedTitle(request);
      const task = this.#tasks.createTask(projectId, {
        title, objective: title, phase: "DISCOVERY", priority: 500,
      });
      return { task, reason: "AUTO_CREATED", ambiguousTaskIds: [] };
    }
    return { reason: "NONE", ambiguousTaskIds: [] };
  }
}
