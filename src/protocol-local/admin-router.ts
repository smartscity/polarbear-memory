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

export { ApiError } from "./admin-errors.js";

export const ADMIN_API_VERSION = "1.2";
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
  "memories.archive",
  "memories.restore",
  "memories.complete",
  "memories.feedback",
  "memories.relate",
  "memories.purge_preview",
  "memories.purge",
  "contexts.explain",
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
      : integer(params.rawEventRetentionDays, "rawEventRetentionDays", 7, 0, 30);
    return updateProjectPolicy(project.configPath, {
      ...(captureMode ? { captureMode } : {}),
      ...(retention !== undefined ? { rawEventRetentionDays: retention } : {}),
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
