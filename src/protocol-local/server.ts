import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { compileContext } from "../application/context.js";
import { MVP_MEMORY_TYPES, type LifecycleStatus, type MemoryType, type VerificationState } from "../domain/memory.js";
import { discoverGitContext } from "../platform/git.js";
import { defaultDataRoot, loadProject } from "../platform/project.js";
import { SqliteMemoryStore } from "../storage/sqlite-store.js";

export const ADMIN_API_VERSION = "1.0";
export const ENGINE_VERSION = "0.1.0";
export const ADMIN_CAPABILITIES = [
  "projects.status",
  "memories.list",
  "memories.get",
  "memories.verify",
  "memories.archive",
  "memories.restore",
  "memories.relate",
  "contexts.explain",
  "knowledge.promote_preview",
  "knowledge.promote",
] as const;

const MAX_FRAME_BYTES = 1024 * 1024;
const SERVICE_DIRECTORY_MODE = 0o700;
const SERVICE_FILE_MODE = 0o600;

export interface AdminServicePaths {
  directory: string;
  socket: string;
  token: string;
}

interface AdminRequest {
  id: string;
  apiVersion: string;
  token: string;
  method: string;
  params?: unknown;
}

interface AdminResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface AdminServiceHandle {
  paths: AdminServicePaths;
  close(): Promise<void>;
}

export function adminServicePaths(dataRoot = defaultDataRoot()): AdminServicePaths {
  const directory = join(dataRoot, "service");
  return { directory, socket: join(directory, "admin-v1.sock"), token: join(directory, "admin-v1.token") };
}

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

class ApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function secureServiceDirectory(paths: AdminServicePaths): void {
  mkdirSync(paths.directory, { recursive: true, mode: SERVICE_DIRECTORY_MODE });
  chmodSync(paths.directory, SERVICE_DIRECTORY_MODE);
  const stat = lstatSync(paths.directory);
  if (!stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("The Memory service directory is not owned by the current user.");
  }
  if ((stat.mode & 0o077) !== 0) throw new Error("The Memory service directory permissions are unsafe.");
}

function serviceToken(paths: AdminServicePaths): string {
  if (!existsSync(paths.token)) {
    writeFileSync(paths.token, randomBytes(32).toString("base64url"), { encoding: "utf8", mode: SERVICE_FILE_MODE, flag: "wx" });
  }
  chmodSync(paths.token, SERVICE_FILE_MODE);
  const stat = lstatSync(paths.token);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("The Memory service token permissions are unsafe.");
  }
  return readFileSync(paths.token, "utf8").trim();
}

function authorized(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeError(error: unknown): { code: string; message: string } {
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

function dispatch(method: string, rawParams: unknown): unknown {
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
  if (method === "memories.relate") {
    return withProject(params.projectRoot, (store, project) => {
      const relation = text(params.relation, "relation", 32).toUpperCase();
      if (relation !== "SUPERSEDES" && relation !== "CONTRADICTS") throw new ApiError("INVALID_ARGUMENT", "Unsupported relation type.");
      store.addRelation(
        project.id,
        text(params.sourceMemoryId, "sourceMemoryId", 128),
        text(params.targetMemoryId, "targetMemoryId", 128),
        relation,
        text(params.reason, "reason", 2048),
      );
      return { recorded: true };
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

function writeResponse(socket: Socket, response: AdminResponse): void {
  const frame = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
    socket.end(`${JSON.stringify({ id: response.id, ok: false, error: { code: "RESPONSE_TOO_LARGE", message: "The response exceeds the local API size limit." } })}\n`);
    return;
  }
  socket.end(frame);
}

function handleSocket(socket: Socket, token: string): void {
  socket.setTimeout(5_000, () => socket.destroy());
  let bytes = 0;
  let input = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > MAX_FRAME_BYTES) return socket.destroy();
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    socket.pause();
    let id = "unknown";
    try {
      const request = JSON.parse(input.slice(0, newline)) as Partial<AdminRequest>;
      if (typeof request.id === "string") id = request.id.slice(0, 128);
      if (typeof request.token !== "string" || !authorized(token, request.token)) throw new ApiError("UNAUTHORIZED", "The local service token is invalid.");
      const major = typeof request.apiVersion === "string" ? request.apiVersion.split(".")[0] : undefined;
      if (major !== ADMIN_API_VERSION.split(".")[0]) throw new ApiError("INCOMPATIBLE_API", `Memory Admin API ${ADMIN_API_VERSION} is required.`);
      if (typeof request.method !== "string") throw new ApiError("INVALID_REQUEST", "method is required.");
      writeResponse(socket, { id, ok: true, result: dispatch(request.method, request.params) });
    } catch (error) {
      writeResponse(socket, { id, ok: false, error: safeError(error) });
    }
  });
}

async function socketIsActive(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return new Promise((resolveActive) => {
    const client = createConnection(path);
    client.once("connect", () => { client.destroy(); resolveActive(true); });
    client.once("error", () => resolveActive(false));
    client.setTimeout(300, () => { client.destroy(); resolveActive(false); });
  });
}

export async function startAdminApi(dataRoot = defaultDataRoot()): Promise<AdminServiceHandle> {
  if (process.platform === "win32") throw new Error("MVP4 local Admin API currently requires a Unix-domain socket platform.");
  const paths = adminServicePaths(dataRoot);
  secureServiceDirectory(paths);
  const token = serviceToken(paths);
  if (await socketIsActive(paths.socket)) throw new Error("Polarbear Memory service is already running.");
  if (existsSync(paths.socket)) {
    const stat = lstatSync(paths.socket);
    if (!stat.isSocket() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Refusing to replace an unsafe service socket path.");
    unlinkSync(paths.socket);
  }
  const server: Server = createServer((socket) => handleSocket(socket, token));
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => { server.off("error", reject); resolveListen(); });
  });
  chmodSync(paths.socket, SERVICE_FILE_MODE);
  return {
    paths,
    close: async () => {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      if (existsSync(paths.socket) && lstatSync(paths.socket).isSocket()) unlinkSync(paths.socket);
    },
  };
}

export async function serveAdminApi(): Promise<void> {
  const handle = await startAdminApi();
  console.log(`Polarbear Memory Admin API ${ADMIN_API_VERSION} is running at ${basename(handle.paths.socket)}.`);
  await new Promise<void>((resolveStop) => {
    const stop = () => void handle.close().finally(resolveStop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
