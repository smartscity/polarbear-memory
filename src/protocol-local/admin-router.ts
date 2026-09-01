import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { compileContext } from "../application/context.js";
import { runMaintenance } from "../application/maintenance.js";
import { inspectBackup, listBackups, restoreBackup } from "../application/recovery.js";
import { MVP_MEMORY_TYPES, type LifecycleStatus, type MemoryType, type VerificationState } from "../domain/memory.js";
import { discoverGitContext } from "../platform/git.js";
import { loadProject, readProjectPolicy, updateProjectPolicy, type CaptureMode } from "../platform/project.js";
import { CURRENT_SCHEMA_VERSION, SqliteMemoryStore } from "../storage/sqlite-store.js";
import { VERSION } from "../version.js";
import { ApiError } from "./admin-errors.js";
import { parseRecordMemoryInput } from "./admin-record-input.js";
import { TASK_PHASES, TASK_STATUSES, emptyCheckpointState, type CheckpointState, type TaskPhase, type TaskStatus } from "../domain/context-os.js";
import { installClaudeIntegration, planClaudeIntegration } from "../adapters/claude-code/integration.js";
import { installCodexIntegration, planCodexIntegration } from "../adapters/codex/integration.js";
import {
  buildPolarbearLaunchSpec, minimalAgentEnvironment, probeMcpLaunch, resolveAgentRuntime,
} from "../platform/agent-launch.js";

export { ApiError } from "./admin-errors.js";

const INTEGRATION_HANDSHAKE_TIMEOUT_MS = 5_000;

export const ADMIN_API_VERSION = "1.5";
export const ENGINE_VERSION = VERSION;
export const ADMIN_CAPABILITIES = [
  "projects.status",
  "system.shutdown",
  "memories.list",
  "memories.get",
  "memories.record",
  "memories.history",
  "memories.update",
  "memories.verify",
  "memories.reject",
  "memories.archive",
  "memories.restore",
  "memories.complete",
  "memories.feedback",
  "memories.relate",
  "memories.purge_preview",
  "memories.purge",
  "contexts.explain",
  "contexts.build",
  "contexts.current",
  "contexts.packet_explain",
  "tasks.list",
  "tasks.get",
  "tasks.create",
  "tasks.checkpoint",
  "tasks.checkpoints",
  "tasks.runs",
  "tasks.run_context",
  "agents.connections",
  "agents.integrations",
  "agents.integrations_repair",
  "observations.distill",
  "usage.context_os",
  "usage.token_savings",
  "usage.token_savings_reset",
  "projects.diagnostics",
  "projects.config",
  "projects.config_update",
  "maintenance.preview",
  "maintenance.run",
  "backups.list",
  "backups.create",
  "backups.verify",
  "backups.restore_preview",
  "backups.restore",
  "knowledge.promote_preview",
  "knowledge.promote",
] as const;

function object(value: unknown, label = "params"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_ARGUMENT", `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxBytes = 16 * 1024): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ApiError("INVALID_ARGUMENT", `${label} is required.`);
  const result = value.trim();
  if (Buffer.byteLength(result, "utf8") > maxBytes) throw new ApiError("INVALID_ARGUMENT", `${label} exceeds its size limit.`);
  return result;
}

function optionalText(value: unknown, label: string, maxBytes = 16 * 1024): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : text(value, label, maxBytes);
}

function integer(value: unknown, label: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ApiError("INVALID_ARGUMENT", `${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function stringArray(value: unknown, label: string, maximum = 100): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new ApiError("INVALID_ARGUMENT", `${label} must be a bounded array.`);
  return value.map((item, index) => text(item, `${label}[${index}]`, 4_096));
}

function checkpointState(value: unknown): CheckpointState {
  if (value === undefined) return emptyCheckpointState();
  const state = object(value, "state");
  if (state.failedAttempts !== undefined && !Array.isArray(state.failedAttempts)) {
    throw new ApiError("INVALID_ARGUMENT", "state.failedAttempts must be an array.");
  }
  if (state.verification !== undefined && !Array.isArray(state.verification)) {
    throw new ApiError("INVALID_ARGUMENT", "state.verification must be an array.");
  }
  const failedAttempts = state.failedAttempts === undefined ? [] : state.failedAttempts.map((item, index) => {
    const attempt = object(item, `state.failedAttempts[${index}]`);
    return { approach: text(attempt.approach, "approach", 4_096), reason: text(attempt.reason, "reason", 4_096) };
  });
  const verification = state.verification === undefined ? [] : state.verification.map((item, index) => {
    const check = object(item, `state.verification[${index}]`);
    return { name: text(check.name, "name", 1_024), status: text(check.status, "status", 256) };
  });
  if (failedAttempts.length > 100 || verification.length > 100) throw new ApiError("INVALID_ARGUMENT", "Checkpoint collections are too large.");
  return {
    changed: stringArray(state.changed, "state.changed"), learned: stringArray(state.learned, "state.learned"),
    decisionsAdded: stringArray(state.decisionsAdded, "state.decisionsAdded"),
    constraintsAdded: stringArray(state.constraintsAdded, "state.constraintsAdded"), failedAttempts,
    filesChanged: stringArray(state.filesChanged, "state.filesChanged", 200), verification,
    unresolved: stringArray(state.unresolved, "state.unresolved"), remaining: stringArray(state.remaining, "state.remaining"),
  };
}

export function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) return { code: error.code, message: error.message };
  const message = error instanceof Error ? error.message : "Unexpected Memory Engine error.";
  if (/not initialized/iu.test(message)) return { code: "PROJECT_NOT_INITIALIZED", message: "This repository has not initialized Polarbear Memory." };
  if (/not a Git repository/iu.test(message)) return { code: "INVALID_PROJECT", message: "The selected folder is not a Git repository." };
  if (/not found/iu.test(message)) return { code: "NOT_FOUND", message: "The requested Memory does not exist in this project." };
  if (/busy|locked/iu.test(message)) return { code: "BUSY", message: "Memory is busy. Try again shortly." };
  return { code: "ENGINE_ERROR", message: "The Memory Engine could not complete the request." };
}

function withProject<T>(projectRoot: unknown, action: (store: SqliteMemoryStore, project: ReturnType<typeof loadProject>) => T): T {
  const root = text(projectRoot, "projectRoot", 16 * 1024);
  const git = discoverGitContext(root);
  const project = loadProject(git);
  const store = new SqliteMemoryStore(project.databasePath);
  try {
    store.initializeProject(project);
    return action(store, project);
  } finally {
    store.close();
  }
}

interface PromotionPlan { path: string; content: string; sha256: string }

function promotionPlan(projectRoot: string, memoryId: string, requestedName?: string): PromotionPlan {
  return withProject(projectRoot, (store, project) => {
    const memory = store.get(project.id, memoryId);
    if (!memory) throw new ApiError("NOT_FOUND", "The requested Memory does not exist in this project.");
    const slug = (requestedName ?? memory.summary)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 64) || "memory";
    const folder = join(project.root, ".polarbear", "knowledge", memory.type.toLowerCase());
    const target = resolve(folder, `${slug}-${memory.id.slice(0, 8)}.md`);
    const relativePath = relative(project.root, target);
    if (relativePath.startsWith(`..${sep}`) || relativePath === "..") throw new ApiError("INVALID_ARGUMENT", "Knowledge target escaped the repository.");
    const document = [
      "---",
      `polarbear_memory_id: ${JSON.stringify(memory.id)}`,
      `type: ${JSON.stringify(memory.type)}`,
      `verification: ${JSON.stringify(memory.verificationState)}`,
      `promotion_source_updated_at: ${JSON.stringify(memory.updatedAt)}`,
      "---",
      "",
      `# ${memory.summary.replaceAll("\n", " ")}`,
      "",
      memory.content,
      "",
      `Source: Polarbear Memory ${memory.id}`,
      "",
    ].join("\n");
    return {
      path: relativePath.split(sep).join("/"),
      content: document,
      sha256: createHash("sha256").update(document).digest("hex"),
    };
  });
}

function promote(projectRoot: string, memoryId: string, expectedSha256: string, requestedName?: string): { path: string; sha256: string } {
  const plan = promotionPlan(projectRoot, memoryId, requestedName);
  if (plan.sha256 !== expectedSha256) throw new ApiError("PROMOTION_CHANGED", "The promotion preview changed. Review it again before writing.");
  const git = discoverGitContext(projectRoot);
  const target = resolve(git.root, plan.path);
  if (relative(git.root, target).startsWith(`..${sep}`)) throw new ApiError("INVALID_ARGUMENT", "Knowledge target escaped the repository.");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, plan.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { path: plan.path, sha256: plan.sha256 };
}

export async function dispatch(method: string, rawParams: unknown): Promise<unknown> {
  const params = object(rawParams ?? {});
  if (method === "system.hello") {
    return { apiVersion: ADMIN_API_VERSION, engineVersion: ENGINE_VERSION, capabilities: ADMIN_CAPABILITIES, transport: "local-user-socket" };
  }
  if (method === "projects.status") {
    return withProject(params.projectRoot, (store, project) => ({
      project: { id: project.id, name: project.name },
      counts: store.status(project.id),
      recent: store.list(project.id, { limit: 8, offset: 0 }),
    }));
  }
  if (method === "projects.diagnostics") {
    return withProject(params.projectRoot, (store, project) => ({
      engineVersion: ENGINE_VERSION,
      apiVersion: ADMIN_API_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      runtime: process.version,
      platform: process.platform,
      architecture: process.arch,
      networkPolicy: "disabled",
      counts: store.status(project.id),
    }));
  }
  if (method === "projects.config") {
    const project = loadProject(discoverGitContext(text(params.projectRoot, "projectRoot", 16 * 1024)));
    return readProjectPolicy(project.configPath);
  }
  if (method === "projects.config_update") {
    const project = loadProject(discoverGitContext(text(params.projectRoot, "projectRoot", 16 * 1024)));
    const captureMode = optionalText(params.captureMode, "captureMode", 16)?.toLowerCase() as CaptureMode | undefined;
    if (captureMode && !["off", "manual", "summary"].includes(captureMode)) throw new ApiError("INVALID_ARGUMENT", "Unsupported capture mode.");
    const retention = params.rawEventRetentionDays === undefined
      ? undefined
      : integer(params.rawEventRetentionDays, "rawEventRetentionDays", 30, 0, 30);
    const contextBudgetMode = optionalText(params.contextBudgetMode, "contextBudgetMode", 16)?.toLowerCase() as "auto" | "custom" | undefined;
    if (contextBudgetMode && contextBudgetMode !== "auto" && contextBudgetMode !== "custom") {
      throw new ApiError("INVALID_ARGUMENT", "Unsupported context budget mode.");
    }
    const defaultContextBudget = params.defaultContextBudget === undefined
      ? undefined
      : integer(params.defaultContextBudget, "defaultContextBudget", 2_000, 400, 12_000);
    return updateProjectPolicy(project.configPath, {
      ...(captureMode ? { captureMode } : {}),
      ...(retention !== undefined ? { rawEventRetentionDays: retention } : {}),
      ...(contextBudgetMode ? { contextBudgetMode } : {}),
      ...(defaultContextBudget !== undefined ? { defaultContextBudget } : {}),
    });
  }
  if (method === "memories.list") {
    return withProject(params.projectRoot, (store, project) => {
      const statusValue = optionalText(params.status, "status", 32)?.toUpperCase() as LifecycleStatus | undefined;
      if (statusValue && !["ACTIVE", "ARCHIVED", "SUPERSEDED", "REJECTED"].includes(statusValue)) throw new ApiError("INVALID_ARGUMENT", "Unsupported lifecycle status.");
      const typeValue = optionalText(params.type, "type", 32)?.toUpperCase() as MemoryType | undefined;
      if (typeValue && !MVP_MEMORY_TYPES.includes(typeValue)) throw new ApiError("INVALID_ARGUMENT", "Unsupported Memory type.");
      const limit = integer(params.limit, "limit", 50, 1, 100);
      const offset = integer(params.offset, "offset", 0, 0, 100_000);
      const query = optionalText(params.query, "query", 1024);
      const items = store.list(project.id, {
        ...(query ? { query } : {}),
        ...(statusValue ? { status: statusValue } : {}),
        ...(typeValue ? { type: typeValue } : {}),
        limit,
        offset,
      });
      return { items, offset, limit, nextOffset: items.length === limit ? offset + limit : null };
    });
  }
  if (method === "memories.get") {
    return withProject(params.projectRoot, (store, project) => {
      const memory = store.get(project.id, text(params.memoryId, "memoryId", 128));
      if (!memory) throw new ApiError("NOT_FOUND", "The requested Memory does not exist in this project.");
      return memory;
    });
  }
  if (method === "memories.record") {
    return withProject(params.projectRoot, (store, project) => store.record(project.id, parseRecordMemoryInput(params)));
  }
  if (method === "memories.history") {
    return withProject(params.projectRoot, (store, project) => ({
      items: store.revisions(project.id, text(params.memoryId, "memoryId", 128)),
    }));
  }
  if (method === "memories.update") {
    return withProject(params.projectRoot, (store, project) => store.update(project.id, text(params.memoryId, "memoryId", 128), {
      summary: text(params.summary, "summary", 2048),
      content: text(params.content, "content", 16 * 1024),
      reason: text(params.reason, "reason", 2048),
    }));
  }
  if (method === "memories.verify") {
    return withProject(params.projectRoot, (store, project) => {
      const state = text(params.state, "state", 32).toUpperCase() as VerificationState;
      if (!["VERIFIED", "DISPUTED", "UNVERIFIED"].includes(state)) throw new ApiError("INVALID_ARGUMENT", "Unsupported verification state.");
      return store.verify(project.id, text(params.memoryId, "memoryId", 128), state, text(params.reason, "reason", 2048), "HUMAN_CLI");
    });
  }
  if (method === "memories.reject") {
    return withProject(params.projectRoot, (store, project) => store.reject(
      project.id,
      text(params.memoryId, "memoryId", 128),
      text(params.reason, "reason", 2048),
    ));
  }
  if (method === "memories.archive") {
    return withProject(params.projectRoot, (store, project) => store.archive(
      project.id,
      text(params.memoryId, "memoryId", 128),
      text(params.reason, "reason", 2048),
      "HUMAN_CLI",
    ));
  }
  if (method === "memories.restore") {
    return withProject(params.projectRoot, (store, project) => store.restore(
      project.id,
      text(params.memoryId, "memoryId", 128),
      text(params.reason, "reason", 2048),
    ));
  }
  if (method === "memories.complete") {
    return withProject(params.projectRoot, (store, project) => {
      const state = text(params.state, "state", 32).toUpperCase();
      if (state !== "COMPLETED" && state !== "CANCELLED") throw new ApiError("INVALID_ARGUMENT", "state must be COMPLETED or CANCELLED.");
      return store.complete(project.id, text(params.memoryId, "memoryId", 128), state, text(params.reason, "reason", 2048));
    });
  }
  if (method === "memories.feedback") {
    return withProject(params.projectRoot, (store, project) => {
      if (typeof params.useful !== "boolean") throw new ApiError("INVALID_ARGUMENT", "useful must be a boolean.");
      return store.noteFeedback(
        project.id,
        text(params.memoryId, "memoryId", 128),
        params.useful,
        text(params.reason, "reason", 2048),
      );
    });
  }
  if (method === "memories.relate") {
    return withProject(params.projectRoot, (store, project) => {
      const relation = text(params.relation, "relation", 32).toUpperCase();
      const relationTypes = ["SUPERSEDES", "CONTRADICTS", "EXTENDS", "DERIVES", "DEPENDS_ON", "RELATED_TO"] as const;
      if (!relationTypes.includes(relation as (typeof relationTypes)[number])) throw new ApiError("INVALID_ARGUMENT", "Unsupported relation type.");
      store.addRelation(
        project.id,
        text(params.sourceMemoryId, "sourceMemoryId", 128),
        text(params.targetMemoryId, "targetMemoryId", 128),
        relation as (typeof relationTypes)[number],
        text(params.reason, "reason", 2048),
      );
      return { recorded: true };
    });
  }
  if (method === "memories.purge_preview" || method === "memories.purge") {
    return withProject(params.projectRoot, (store, project) => {
      const memoryId = text(params.memoryId, "memoryId", 128);
      const memory = store.get(project.id, memoryId);
      if (!memory) throw new ApiError("NOT_FOUND", "The requested Memory does not exist in this project.");
      const confirmation = `PURGE ${memory.id}`;
      if (method === "memories.purge_preview") return {
        memory: { id: memory.id, summary: memory.summary, type: memory.type, revisionCount: memory.revisionCount },
        confirmation,
        warning: "Physical purge deletes the operational Memory, revisions, anchors and relations. Existing backups may retain copies.",
      };
      if (text(params.confirmation, "confirmation", 1024) !== confirmation) throw new ApiError("CONFIRMATION_REQUIRED", `Type exactly: ${confirmation}`);
      return store.purge(project.id, memoryId, text(params.reason, "reason", 2048));
    });
  }
  if (method === "contexts.explain") {
    return withProject(params.projectRoot, (store, project) => compileContext(
      store,
      project.id,
      text(params.task, "task", 4096),
      integer(params.budget, "budget", 1000, 200, 4000),
    ));
  }
  if (method === "tasks.list") {
    return withProject(params.projectRoot, (store, project) => {
      const status = optionalText(params.status, "status", 32)?.toUpperCase() as TaskStatus | undefined;
      if (status && !TASK_STATUSES.includes(status)) throw new ApiError("INVALID_ARGUMENT", "Unsupported task status.");
      return { items: store.contextOs().listTasks(project.id, status) };
    });
  }
  if (method === "tasks.get") {
    return withProject(params.projectRoot, (store, project) => {
      const taskId = text(params.taskId, "taskId", 128);
      const task = store.contextOs().getTask(project.id, taskId);
      if (!task) throw new ApiError("NOT_FOUND", "The requested Task does not exist in this project.");
      return task;
    });
  }
  if (method === "tasks.create") {
    return withProject(params.projectRoot, (store, project) => {
      const phase = (optionalText(params.phase, "phase", 32)?.toUpperCase() ?? "DISCOVERY") as TaskPhase;
      if (!TASK_PHASES.includes(phase)) throw new ApiError("INVALID_ARGUMENT", "Unsupported task phase.");
      return store.contextOs().createTask(project.id, {
        title: text(params.title, "title", 1_024), objective: text(params.objective, "objective", 16 * 1024), phase,
        priority: integer(params.priority, "priority", 500, 0, 1_000),
        ...(optionalText(params.parentTaskId, "parentTaskId", 128) ? { parentTaskId: String(params.parentTaskId) } : {}),
      });
    });
  }
  if (method === "tasks.checkpoint") {
    return withProject(params.projectRoot, (store, project) => {
      const status = text(params.status, "status", 32).toUpperCase() as TaskStatus;
      const phase = text(params.phase, "phase", 32).toUpperCase() as TaskPhase;
      if (!TASK_STATUSES.includes(status) || !TASK_PHASES.includes(phase)) {
        throw new ApiError("INVALID_ARGUMENT", "Unsupported task status or phase.");
      }
      return store.contextOs().checkpoint(project.id, {
        taskId: text(params.taskId, "taskId", 128), status, phase,
        summary: text(params.summary, "summary", 4_096), state: checkpointState(params.state),
        ...(optionalText(params.idempotencyKey, "idempotencyKey", 512) ? { idempotencyKey: String(params.idempotencyKey) } : {}),
      });
    });
  }
  if (method === "tasks.checkpoints") {
    return withProject(params.projectRoot, (store, project) => ({
      items: store.contextOs().listCheckpoints(
        project.id,
        text(params.taskId, "taskId", 128),
        integer(params.limit, "limit", 20, 1, 100),
      ),
    }));
  }
  if (method === "tasks.runs") {
    return withProject(params.projectRoot, (store, project) => ({
      items: store.contextOs().listTaskRuns(
        project.id,
        text(params.taskId, "taskId", 128),
        integer(params.limit, "limit", 20, 1, 100),
      ),
    }));
  }
  if (method === "tasks.run_context") {
    return withProject(params.projectRoot, (store, project) => store.contextOs().getTaskRunContext(
      project.id,
      text(params.taskId, "taskId", 128),
      text(params.runId, "runId", 128),
    ));
  }
  if (method === "agents.connections") {
    return withProject(params.projectRoot, (store, project) => ({ items: store.contextOs().listAgentConnections(project.id) }));
  }
  if (method === "agents.integrations" || method === "agents.integrations_repair") {
    const project = loadProject(discoverGitContext(text(params.projectRoot, "projectRoot", 16 * 1024)));
    const runtime = resolveAgentRuntime();
    if (method === "agents.integrations_repair") {
      const integration = text(params.integration, "integration", 32).toLowerCase();
      if (integration === "codex") installCodexIntegration(project, { dryRun: false, runtime });
      else if (integration === "claude-code") installClaudeIntegration(project, { dryRun: false, runtime });
      else throw new ApiError("INVALID_ARGUMENT", "Unsupported agent integration.");
    }
    let codexPlan: ReturnType<typeof planCodexIntegration> | undefined;
    let claudePlan: ReturnType<typeof planClaudeIntegration> | undefined;
    try { codexPlan = planCodexIntegration(project, runtime); } catch { codexPlan = undefined; }
    try { claudePlan = planClaudeIntegration(project, runtime); } catch { claudePlan = undefined; }
    const configured = Boolean(codexPlan?.alreadyInstalled || claudePlan?.alreadyInstalled);
    const probe = configured
      ? await probeMcpLaunch(
          buildPolarbearLaunchSpec(runtime, ["mcp", "--stdio", "--project-root", project.root]),
          {
            cwd: project.root,
            env: minimalAgentEnvironment(process.env, process.platform, runtime.executable),
            timeoutMs: INTEGRATION_HANDSHAKE_TIMEOUT_MS,
          },
        )
      : null;
    const connectedDetails = {
      mcp: "CONFIGURED" as const,
      runtime: "READY" as const,
      handshake: probe?.ok ? "OK" as const : "FAILED" as const,
    };
    const unavailableDetails = {
      mcp: "NOT_CONFIGURED" as const,
      runtime: "READY" as const,
      handshake: "NOT_CHECKED" as const,
    };
    const codex = (() => {
      try {
        if (!codexPlan) throw new Error("Codex configuration is unavailable.");
        return codexPlan.alreadyInstalled
          ? {
              id: "codex", name: "Codex", status: probe?.ok ? "CONNECTED" : "NEEDS_ATTENTION",
              ...(!probe?.ok ? { detail: "HANDSHAKE_FAILED" } : {}), ...connectedDetails,
              integrationMode: "MCP_ASSISTED", lifecycle: "UNSUPPORTED",
            }
          : {
              id: "codex",
              name: "Codex",
              status: "NEEDS_ATTENTION",
              detail: codexPlan.conflict ? "CONFIGURATION_CONFLICT" : codexPlan.migrationRequired ? "MIGRATION_REQUIRED" : "INSTALL_REQUIRED",
              ...unavailableDetails, integrationMode: "UNAVAILABLE", lifecycle: "UNSUPPORTED",
            };
      } catch {
        return {
          id: "codex", name: "Codex", status: "NEEDS_ATTENTION", detail: "CONFIGURATION_CONFLICT",
          ...unavailableDetails, integrationMode: "UNAVAILABLE", lifecycle: "UNSUPPORTED",
        };
      }
    })();
    const claude = (() => {
      try {
        if (!claudePlan) throw new Error("Claude Code configuration is unavailable.");
        return claudePlan.alreadyInstalled
          ? {
              id: "claude-code", name: "Claude Code", status: probe?.ok ? "CONNECTED" : "NEEDS_ATTENTION",
              ...(!probe?.ok ? { detail: "HANDSHAKE_FAILED" } : {}), ...connectedDetails,
              integrationMode: "LIFECYCLE_MANAGED", lifecycle: "CONFIGURED",
            }
          : {
              id: "claude-code",
              name: "Claude Code",
              status: "NEEDS_ATTENTION",
              detail: claudePlan.legacyConfiguration ? "MIGRATION_REQUIRED" : "INSTALL_REQUIRED",
              ...unavailableDetails, integrationMode: "UNAVAILABLE", lifecycle: "NOT_CONFIGURED",
            };
      } catch {
        return {
          id: "claude-code", name: "Claude Code", status: "NEEDS_ATTENTION", detail: "CONFIGURATION_CONFLICT",
          ...unavailableDetails, integrationMode: "UNAVAILABLE", lifecycle: "NOT_CONFIGURED",
        };
      }
    })();
    return {
      items: [codex, claude],
    };
  }
  if (method === "contexts.build") {
    return withProject(params.projectRoot, (store, project) => {
      const policy = readProjectPolicy(project.configPath);
      const requestedBudget = params.maxTokens === undefined
        ? (policy.contextBudgetMode === "custom" ? policy.defaultContextBudget : undefined)
        : integer(params.maxTokens, "maxTokens", 2_000, 400, 12_000);
      return store.contextOs().buildContext(project.id, {
      currentRequest: text(params.currentRequest, "currentRequest", 16 * 1024),
      ...(optionalText(params.taskId, "taskId", 128) ? { taskId: String(params.taskId) } : {}),
      ...(requestedBudget === undefined ? {} : { maxTokens: requestedBudget }),
      ...(optionalText(params.provider, "provider", 128) ? { provider: String(params.provider) } : {}),
      });
    });
  }
  if (method === "contexts.current") {
    return withProject(params.projectRoot, (store, project) => ({
      packet: store.contextOs().currentContext(project.id) ?? null,
    }));
  }
  if (method === "contexts.packet_explain") {
    return withProject(params.projectRoot, (store, project) => store.contextOs().explainContext(
      project.id, text(params.packetId, "packetId", 128),
    ));
  }
  if (method === "observations.distill") {
    return withProject(params.projectRoot, (store, project) => store.contextOs().distill(
      project.id, integer(params.limit, "limit", 200, 1, 1_000),
    ));
  }
  if (method === "usage.context_os") {
    return withProject(params.projectRoot, (store, project) => store.contextOs().metrics(
      project.id, optionalText(params.taskId, "taskId", 128),
    ));
  }
  if (method === "usage.token_savings") {
    return withProject(params.projectRoot, (store, project) => store.tokenSavings(project.id));
  }
  if (method === "usage.token_savings_reset") {
    return withProject(params.projectRoot, (store, project) => {
      if (text(params.confirmation, "confirmation", 64) !== "RESET") {
        throw new ApiError("CONFIRMATION_REQUIRED", "Type exactly: RESET");
      }
      return store.resetTokenSavings(project.id, new Date().toISOString());
    });
  }
  if (method === "maintenance.preview" || method === "maintenance.run") {
    return withProject(params.projectRoot, (store, project) => {
      const git = discoverGitContext(project.root);
      return runMaintenance(store, project.id, project.root, {
        dryRun: method === "maintenance.preview",
        limit: integer(params.limit, "limit", 200, 1, 1000),
        ...(git.head ? { head: git.head } : {}),
      });
    });
  }
  if (method === "backups.list") {
    const project = loadProject(discoverGitContext(text(params.projectRoot, "projectRoot", 16 * 1024)));
    return { items: listBackups(project).map(({ path: _path, ...item }) => item) };
  }
  if (method === "backups.verify") {
    const project = loadProject(discoverGitContext(text(params.projectRoot, "projectRoot", 16 * 1024)));
    const { path: _path, ...inspection } = inspectBackup(project, text(params.fileName, "fileName", 512));
    return inspection;
  }
  if (method === "backups.create") {
    const project = loadProject(discoverGitContext(text(params.projectRoot, "projectRoot", 16 * 1024)));
    const destination = join(project.dataDir, "backups", `memory-${new Date().toISOString().replaceAll(":", "-")}.db`);
    const store = new SqliteMemoryStore(project.databasePath);
    try {
      const pages = await store.backup(destination);
      const { path: _path, ...inspection } = inspectBackup(project, destination);
      return { ...inspection, pages };
    } finally {
      store.close();
    }
  }
  if (method === "backups.restore_preview" || method === "backups.restore") {
    const project = loadProject(discoverGitContext(text(params.projectRoot, "projectRoot", 16 * 1024)));
    const fileName = text(params.fileName, "fileName", 512);
    const { path: _path, ...inspection } = inspectBackup(project, fileName);
    const confirmation = `RESTORE ${inspection.fileName}`;
    if (method === "backups.restore_preview") {
      return { backup: inspection, confirmation, warning: "Restore replaces the operational database and preserves the current database as a rollback backup." };
    }
    if (text(params.confirmation, "confirmation", 1024) !== confirmation) throw new ApiError("CONFIRMATION_REQUIRED", `Type exactly: ${confirmation}`);
    const result = restoreBackup(project, fileName);
    return { restored: inspection, rollbackFileName: result.rollbackPath ? basename(result.rollbackPath) : null };
  }
  if (method === "knowledge.promote_preview") {
    return promotionPlan(
      text(params.projectRoot, "projectRoot", 16 * 1024),
      text(params.memoryId, "memoryId", 128),
      optionalText(params.name, "name", 256),
    );
  }
  if (method === "knowledge.promote") {
    return promote(
      text(params.projectRoot, "projectRoot", 16 * 1024),
      text(params.memoryId, "memoryId", 128),
      text(params.expectedSha256, "expectedSha256", 128),
      optionalText(params.name, "name", 256),
    );
  }
  throw new ApiError("METHOD_NOT_FOUND", "This Memory Engine does not support the requested capability.");
}
