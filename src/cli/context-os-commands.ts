import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ClaudeCodeCliRuntime } from "../adapters/claude-code/runtime.js";
import { CodexCliRuntime } from "../adapters/codex/runtime.js";
import { emptyCheckpointState, TASK_PHASES, TASK_STATUSES, validateCheckpointState, type TaskPhase, type TaskStatus } from "../domain/context-os.js";
import { discoverGitContext } from "../platform/git.js";
import { loadProject } from "../platform/project.js";
import { RuntimeRouter } from "../runtime/runtime-router.js";
import { SessionManager } from "../runtime/session-manager.js";
import { SqliteMemoryStore } from "../storage/sqlite-store.js";

function open(cwd: string): { store: SqliteMemoryStore; project: ReturnType<typeof loadProject> } {
  const project = loadProject(discoverGitContext(cwd));
  const store = new SqliteMemoryStore(project.databasePath);
  store.initializeProject(project);
  return { store, project };
}

function enumValue<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  const resolved = (value?.toUpperCase() ?? fallback) as T;
  if (!allowed.includes(resolved)) throw new Error(`Expected one of: ${allowed.join(", ")}.`);
  return resolved;
}

export function taskCommand(cwd: string, args: string[]): void {
  const [action, ...rest] = args;
  const { store, project } = open(cwd);
  try {
    if (action === "create") {
      const parsed = parseArgs({
        args: rest,
        options: {
          title: { type: "string" }, objective: { type: "string" }, phase: { type: "string" },
          priority: { type: "string" }, parent: { type: "string" },
        },
        strict: true,
      });
      if (!parsed.values.title || !parsed.values.objective) throw new Error("task create requires --title and --objective.");
      const task = store.contextOs().createTask(project.id, {
        title: parsed.values.title, objective: parsed.values.objective,
        phase: enumValue(parsed.values.phase, TASK_PHASES, "DISCOVERY"),
        priority: parsed.values.priority ? Number(parsed.values.priority) : 500,
        ...(parsed.values.parent ? { parentTaskId: parsed.values.parent } : {}),
      });
      console.log(JSON.stringify(task, null, 2));
      return;
    }
    if (action === "status") {
      if (rest.length > 1) throw new Error("task status accepts at most one task ID.");
      const result = rest[0] ? store.contextOs().getTask(project.id, rest[0]) : store.contextOs().listTasks(project.id);
      if (!result) throw new Error(`Task not found: ${rest[0]}`);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    throw new Error("task requires `create` or `status [TASK_ID]`.");
  } finally {
    store.close();
  }
}

export function contextOsCommand(cwd: string, args: string[]): void {
  const [action, ...rest] = args;
  const { store, project } = open(cwd);
  try {
    if (action === "build") {
      const parsed = parseArgs({
        args: rest,
        options: {
          task: { type: "string" }, request: { type: "string" }, budget: { type: "string" }, provider: { type: "string" },
        }, strict: true,
      });
      if (!parsed.values.request) throw new Error("context build requires --request.");
      const packet = store.contextOs().buildContext(project.id, {
        currentRequest: parsed.values.request, ...(parsed.values.task ? { taskId: parsed.values.task } : {}),
        maxTokens: parsed.values.budget ? Number(parsed.values.budget) : 2_000,
        ...(parsed.values.provider ? { provider: parsed.values.provider } : {}),
      });
      console.log(packet.rendered);
      console.log(`Packet: ${packet.id} (${packet.estimatedTokens}/${packet.maxTokens} tokens)`);
      return;
    }
    if (action === "explain" && rest.length === 1 && rest[0]) {
      console.log(JSON.stringify(store.contextOs().explainContext(project.id, rest[0]), null, 2));
      return;
    }
    if (action === "status" && rest.length === 0) {
      const packet = store.contextOs().currentContext(project.id);
      const task = packet?.taskId ? store.contextOs().getTask(project.id, packet.taskId) : undefined;
      const checkpoint = task ? store.contextOs().latestCheckpoint(project.id, task.id) : undefined;
      console.log(JSON.stringify({
        packet: packet ?? null,
        receipt: packet ? store.contextOs().contextReceipt(project.id, packet.id) : null,
        task: task ?? null,
        latestCheckpoint: checkpoint ?? null,
        safeToReplaceSession: Boolean(checkpoint),
      }, null, 2));
      return;
    }
    throw new Error("context requires `build --request TEXT`, `explain PACKET_ID`, or `status`.");
  } finally {
    store.close();
  }
}

export function checkpointCommand(cwd: string, args: string[]): void {
  const parsed = parseArgs({
    args,
    options: {
      task: { type: "string" }, summary: { type: "string" }, status: { type: "string" }, phase: { type: "string" },
      state: { type: "string" }, "idempotency-key": { type: "string" },
    }, strict: true,
  });
  if (!parsed.values.task || !parsed.values.summary) throw new Error("checkpoint requires --task and --summary.");
  const state = parsed.values.state
    ? validateCheckpointState(JSON.parse(readFileSync(parsed.values.state, "utf8")) as unknown)
    : emptyCheckpointState();
  const { store, project } = open(cwd);
  try {
    console.log(JSON.stringify(store.contextOs().checkpoint(project.id, {
      taskId: parsed.values.task, summary: parsed.values.summary,
      status: enumValue(parsed.values.status, TASK_STATUSES, "ACTIVE") as TaskStatus,
      phase: enumValue(parsed.values.phase, TASK_PHASES, "IMPLEMENTATION") as TaskPhase,
      state, ...(parsed.values["idempotency-key"] ? { idempotencyKey: parsed.values["idempotency-key"] } : {}),
    }), null, 2));
  } finally {
    store.close();
  }
}

export function metricsCommand(cwd: string, args: string[]): void {
  const parsed = parseArgs({
    args,
    options: { task: { type: "string" }, lifecycle: { type: "boolean", default: false } },
    strict: true,
  });
  if (parsed.values.lifecycle && parsed.values.task) throw new Error("metrics --lifecycle does not accept --task.");
  const { store, project } = open(cwd);
  try {
    console.log(JSON.stringify(parsed.values.lifecycle
      ? store.contextOs().lifecycleMetrics(project.id)
      : store.contextOs().metrics(project.id, parsed.values.task), null, 2));
  } finally {
    store.close();
  }
}

export async function managedRunCommand(cwd: string, args: string[]): Promise<void> {
  if (process.env.POLARBEAR_MANAGED_SESSIONS !== "1") {
    throw new Error("Managed sessions are disabled. Set POLARBEAR_MANAGED_SESSIONS=1 after reviewing runtime permissions.");
  }
  const parsed = parseArgs({
    args,
    options: {
      provider: { type: "string" }, task: { type: "string" }, phase: { type: "string" },
      budget: { type: "string" }, model: { type: "string" }, resume: { type: "string" }, fresh: { type: "boolean", default: false },
      writable: { type: "boolean", default: false },
    }, allowPositionals: true, strict: true,
  });
  if (!parsed.values.provider || !parsed.values.task || parsed.positionals.length !== 1 || !parsed.positionals[0]) {
    throw new Error("run requires --provider, --task and one request argument.");
  }
  const { store, project } = open(cwd);
  try {
    const router = new RuntimeRouter().register(new CodexCliRuntime()).register(new ClaudeCodeCliRuntime());
    const manager = new SessionManager(store.contextOs(), router);
    const result = await manager.run({
      projectId: project.id, taskId: parsed.values.task, provider: parsed.values.provider,
      request: parsed.positionals[0], cwd: project.root,
      phase: enumValue(parsed.values.phase, TASK_PHASES, "IMPLEMENTATION"),
      maxTokens: parsed.values.budget ? Number(parsed.values.budget) : 2_000,
      ...(parsed.values.model ? { model: parsed.values.model } : {}),
      ...(parsed.values.resume ? { resumeSessionId: parsed.values.resume } : {}),
      fresh: parsed.values.fresh, writable: parsed.values.writable,
    });
    console.log(result.result.finalResponse);
    console.log(`Run: ${result.runId}; Packet: ${result.packetId}; Session: ${result.result.session.id}`);
  } finally {
    store.close();
  }
}
