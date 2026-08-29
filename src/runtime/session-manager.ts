import { createHash } from "node:crypto";
import type { ContextOsPort, ContextPacket, RotationContext, TaskPhase } from "../domain/context-os.js";
import type { RuntimeTurnResult } from "./agent-runtime.js";
import type { RuntimeRouter } from "./runtime-router.js";

export interface ManagedRunInput {
  projectId: string;
  taskId: string;
  provider: string;
  request: string;
  cwd: string;
  phase: TaskPhase;
  maxTokens?: number;
  model?: string;
  resumeSessionId?: string;
  fresh?: boolean;
  writable?: boolean;
  rotation?: RotationContext;
}

export class SessionManager {
  readonly #contextOs: ContextOsPort;
  readonly #router: RuntimeRouter;

  constructor(contextOs: ContextOsPort, router: RuntimeRouter) {
    this.#contextOs = contextOs;
    this.#router = router;
  }

  async run(input: ManagedRunInput): Promise<{ runId: string; packetId: string; result: RuntimeTurnResult }> {
    const runtime = this.#router.resolve(input.provider);
    const detected = await runtime.detect();
    if (!detected.available) throw new Error(`Managed runtime is not available: ${input.provider}`);
    const task = this.#contextOs.getTask(input.projectId, input.taskId);
    if (!task) throw new Error(`Task not found: ${input.taskId}`);
    const decision = this.#contextOs.decideRotation({
      ...input.rotation, ...(input.fresh !== undefined ? { manualRequest: input.fresh } : {}),
    });
    if (decision.rotate && !task.lastCheckpointId) {
      throw new Error(`Rotation requires a durable checkpoint for task ${task.id}. Run task checkpoint first.`);
    }
    if (decision.rotate) {
      const latest = this.#contextOs.latestCheckpoint(input.projectId, task.id);
      if (!latest) throw new Error(`Rotation checkpoint is unavailable for task ${task.id}.`);
      this.#contextOs.checkpoint(input.projectId, {
        taskId: task.id, status: task.status, phase: task.phase,
        summary: `Durable boundary before session rotation (${decision.reason ?? "policy"}).`,
        state: latest.state, delta: {},
        idempotencyKey: `rotation:${latest.id}:${decision.reason ?? "policy"}`,
      });
    }
    const packet = this.#contextOs.buildContext(input.projectId, {
      taskId: task.id, currentRequest: input.request,
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}), provider: input.provider,
    });
    const prompt = packet.rendered;
    if (!decision.rotate && input.resumeSessionId) {
      const resumeRun = this.#startRun(input, packet.id, input.model, input.resumeSessionId);
      try {
        const result = await runtime.resume({ id: input.resumeSessionId, provider: input.provider }, {
          prompt, cwd: input.cwd, ...(input.model ? { model: input.model } : {}),
          ...(input.writable !== undefined ? { writable: input.writable } : {}),
        });
        return this.#completeRun(input, resumeRun.id, packet, result);
      } catch {
        this.#contextOs.finishExecution(input.projectId, resumeRun.id, { status: "FAILED" });
        const recoveryRun = this.#startRun(input, packet.id, input.model, undefined, "PROVIDER_ERROR_RECOVERY");
        try {
          const result = await runtime.start({
            prompt, cwd: input.cwd, ...(input.model ? { model: input.model } : {}),
            ...(input.writable !== undefined ? { writable: input.writable } : {}),
          });
          return this.#completeRun(input, recoveryRun.id, packet, result);
        } catch (error) {
          this.#contextOs.finishExecution(input.projectId, recoveryRun.id, { status: "FAILED" });
          throw error;
        }
      }
    }
    const run = this.#startRun(input, packet.id, input.model, undefined, decision.reason);
    try {
      const result = await runtime.start({
        prompt, cwd: input.cwd, ...(input.model ? { model: input.model } : {}),
        ...(input.writable !== undefined ? { writable: input.writable } : {}),
      });
      return this.#completeRun(input, run.id, packet, result);
    } catch (error) {
      this.#contextOs.finishExecution(input.projectId, run.id, { status: "FAILED" });
      throw error;
    }
  }

  #startRun(
    input: ManagedRunInput,
    packetId: string,
    model: string | undefined,
    externalSessionRef?: string,
    rotationReason?: Parameters<ContextOsPort["startExecution"]>[1]["rotationReason"],
  ) {
    return this.#contextOs.startExecution(input.projectId, {
      taskId: input.taskId, provider: input.provider, phase: input.phase, integrationMode: "MANAGED",
      contextPacketId: packetId, ...(model ? { model } : {}),
      ...(rotationReason ? { rotationReason } : {}), ...(externalSessionRef ? { externalSessionRef } : {}),
    });
  }

  #completeRun(
    input: ManagedRunInput,
    runId: string,
    packet: ContextPacket,
    result: RuntimeTurnResult,
  ): { runId: string; packetId: string; result: RuntimeTurnResult } {
    this.#contextOs.finishExecution(input.projectId, runId, { status: "SUCCEEDED", externalSessionRef: result.session.id });
    this.#recordResult(input, runId, packet, result, true);
    return { runId, packetId: packet.id, result };
  }

  #recordResult(
    input: ManagedRunInput,
    runId: string,
    packet: ContextPacket,
    result: RuntimeTurnResult,
    successful: boolean,
  ): void {
    const occurredAt = new Date().toISOString();
    const usefulContextTokens = packet.items
      .filter((item) => result.finalResponse.includes(item.sourceId))
      .reduce((total, item) => total + item.estimatedTokens, 0);
    this.#contextOs.recordObservation(input.projectId, {
      taskId: input.taskId, executionRunId: runId, provider: input.provider, eventType: "TURN_COMPLETED",
      payload: { packetId: packet.id, eventCount: result.events.length, finalResponseDigest: createHash("sha256").update(result.finalResponse).digest("hex") },
      artifactRefs: [], estimatedTokens: result.usage.outputTokens, importance: 700, occurredAt,
      sourceFingerprint: createHash("sha256").update(`${runId}\0TURN_COMPLETED`).digest("hex"),
    });
    this.#contextOs.recordUsage(input.projectId, {
      taskId: input.taskId, executionRunId: runId, provider: input.provider,
      inputTokens: result.usage.inputTokens, cachedInputTokens: result.usage.cachedInputTokens,
      outputTokens: result.usage.outputTokens, contextPacketTokens: packet.estimatedTokens,
      usefulContextTokens, successful,
    });
  }
}
