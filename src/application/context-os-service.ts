import type {
  ContextOsMetrics, ContextOsPort, ContextPacket, ContextExplanation, Observation, RotationContext,
  RotationDecision, Task, TaskStatus, UsageLedgerEntry,
} from "../domain/context-os.js";
import type { MemorySearchResult } from "../domain/memory.js";
import type { TaskCheckpointRepository } from "../storage/task-checkpoint-repository.js";
import type { ContextPacketRepository } from "../storage/context-packet-repository.js";
import type { ContextTelemetryRepository } from "../storage/context-telemetry-repository.js";
import type { ExecutionRepository } from "../storage/execution-repository.js";
import { ContextPlanner } from "./context-planner.js";
import { RotationPolicy } from "../runtime/rotation-policy.js";
import { ObservationDistiller } from "./observation-distiller.js";
import type { Memory, RecordMemoryInput } from "../domain/memory.js";

export class ContextOsService implements ContextOsPort {
  readonly #tasks: TaskCheckpointRepository;
  readonly #packets: ContextPacketRepository;
  readonly #telemetry: ContextTelemetryRepository;
  readonly #executions: ExecutionRepository;
  readonly #planner: ContextPlanner;
  readonly #rotation: RotationPolicy;
  readonly #distiller: ObservationDistiller;

  constructor(
    tasks: TaskCheckpointRepository,
    packets: ContextPacketRepository,
    telemetry: ContextTelemetryRepository,
    executions: ExecutionRepository,
    recall: {
      search(projectId: string, query: string, limit: number): MemorySearchResult[];
      recent(projectId: string, limit: number): MemorySearchResult[];
    },
    record: (projectId: string, input: RecordMemoryInput) => Memory,
    rotation = new RotationPolicy(),
  ) {
    this.#tasks = tasks;
    this.#packets = packets;
    this.#telemetry = telemetry;
    this.#executions = executions;
    this.#planner = new ContextPlanner(tasks, packets, recall);
    this.#rotation = rotation;
    this.#distiller = new ObservationDistiller(telemetry, record);
  }

  createTask(projectId: string, input: Parameters<ContextOsPort["createTask"]>[1]): Task {
    return this.#tasks.createTask(projectId, input);
  }

  getTask(projectId: string, taskId: string): Task | undefined {
    return this.#tasks.getTask(projectId, taskId);
  }

  listTasks(projectId: string, status?: TaskStatus): Task[] {
    return this.#tasks.listTasks(projectId, status);
  }

  latestCheckpoint(projectId: string, taskId: string) {
    return this.#tasks.latestCheckpoint(projectId, taskId);
  }

  listCheckpoints(projectId: string, taskId: string, limit?: number) {
    return this.#tasks.listCheckpoints(projectId, taskId, limit);
  }

  checkpoint(projectId: string, input: Parameters<ContextOsPort["checkpoint"]>[1]) {
    return this.#tasks.checkpoint(projectId, input);
  }

  listTaskRuns(projectId: string, taskId: string, limit?: number) {
    this.#tasks.requireTask(projectId, taskId);
    return this.#executions.listForTask(projectId, taskId, limit);
  }

  getTaskRunContext(projectId: string, taskId: string, runId: string) {
    this.#tasks.requireTask(projectId, taskId);
    const run = this.#executions.require(projectId, runId);
    if (run.taskId !== taskId) throw new Error(`Execution run does not belong to task: ${runId}`);
    const packet = run.contextPacketId ? this.#packets.get(projectId, run.contextPacketId) : undefined;
    return { run, ...(packet ? { packet } : {}) };
  }

  listAgentConnections(projectId: string) {
    return this.#executions.agentConnections(projectId);
  }

  startExecution(projectId: string, input: Parameters<ContextOsPort["startExecution"]>[1]) {
    return this.#executions.start(projectId, input);
  }

  finishExecution(projectId: string, runId: string, input: Parameters<ContextOsPort["finishExecution"]>[2]) {
    return this.#executions.finish(projectId, runId, input);
  }

  buildContext(projectId: string, input: Parameters<ContextOsPort["buildContext"]>[1]): ContextPacket {
    return this.#planner.build(projectId, input);
  }

  currentContext(projectId: string): ContextPacket | undefined {
    return this.#packets.latest(projectId);
  }

  explainContext(projectId: string, packetId: string): ContextExplanation {
    return this.#packets.explain(projectId, packetId);
  }

  recordObservation(
    projectId: string,
    input: Omit<Observation, "id" | "projectId"> & { sourceFingerprint?: string },
  ): Observation {
    return this.#telemetry.recordObservation(projectId, input);
  }

  distill(projectId: string, limit?: number, sessionRefHash?: string) {
    return this.#distiller.distill(projectId, limit, sessionRefHash);
  }

  recordUsage(
    projectId: string,
    input: Omit<UsageLedgerEntry, "id" | "projectId" | "createdAt">,
  ): UsageLedgerEntry {
    return this.#telemetry.recordUsage(projectId, input);
  }

  metrics(projectId: string, taskId?: string): ContextOsMetrics {
    return this.#telemetry.metrics(projectId, taskId);
  }

  decideRotation(input: RotationContext): RotationDecision {
    return this.#rotation.decide(input);
  }
}
