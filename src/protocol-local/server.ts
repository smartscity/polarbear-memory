import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { compileContext } from "../application/context.js";
import { runMaintenance } from "../application/maintenance.js";
import { inspectBackup, listBackups, restoreBackup } from "../application/recovery.js";
import { MVP_MEMORY_TYPES, type LifecycleStatus, type MemoryType, type VerificationState } from "../domain/memory.js";
import { discoverGitContext } from "../platform/git.js";
import { defaultDataRoot, loadProject, readProjectPolicy, updateProjectPolicy, type CaptureMode } from "../platform/project.js";
import { CURRENT_SCHEMA_VERSION, SqliteMemoryStore } from "../storage/sqlite-store.js";
import { VERSION } from "../version.js";
import {
  ADMIN_API_VERSION,
  ADMIN_CAPABILITIES,
  ApiError,
  ENGINE_VERSION,
  dispatch,
  safeError,
} from "./admin-router.js";

export { ADMIN_API_VERSION, ADMIN_CAPABILITIES, ENGINE_VERSION } from "./admin-router.js";

const MAX_FRAME_BYTES = 1024 * 1024;
const ADMIN_REQUEST_TIMEOUT_MS = 15_000;
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
  closed: Promise<void>;
  close(): Promise<void>;
}

export function adminServicePaths(dataRoot = defaultDataRoot()): AdminServicePaths {
  const directory = join(dataRoot, "service");
  return { directory, socket: join(directory, "admin-v1.sock"), token: join(directory, "admin-v1.token") };
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

function writeResponse(socket: Socket, response: AdminResponse): void {
  const frame = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
    socket.end(`${JSON.stringify({ id: response.id, ok: false, error: { code: "RESPONSE_TOO_LARGE", message: "The response exceeds the local API size limit." } })}\n`);
    return;
  }
  socket.end(frame);
}

function handleSocket(socket: Socket, token: string, shutdown: () => void): void {
  socket.setTimeout(ADMIN_REQUEST_TIMEOUT_MS, () => socket.destroy());
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
      if (request.method === "system.shutdown") {
        socket.once("finish", shutdown);
        writeResponse(socket, { id, ok: true, result: { stopping: true } });
        return;
      }
      void dispatch(request.method, request.params)
        .then((result) => writeResponse(socket, { id, ok: true, result }))
        .catch((error: unknown) => writeResponse(socket, { id, ok: false, error: safeError(error) }));
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
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let closePromise: Promise<void> | undefined;
  const server: Server = createServer((socket) => handleSocket(socket, token, () => { void close(); }));
  server.once("close", () => resolveClosed?.());
  const close = (): Promise<void> => {
    closePromise ??= new Promise<void>((resolveClose, reject) => {
      server.close((error) => {
        if (error) { reject(error); return; }
        if (existsSync(paths.socket) && lstatSync(paths.socket).isSocket()) unlinkSync(paths.socket);
        resolveClose();
      });
    });
    return closePromise;
  };
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => { server.off("error", reject); resolveListen(); });
  });
  chmodSync(paths.socket, SERVICE_FILE_MODE);
  return {
    paths,
    closed,
    close,
  };
}

export async function serveAdminApi(): Promise<void> {
  const handle = await startAdminApi();
  console.log(`Polarbear Memory Admin API ${ADMIN_API_VERSION} is running at ${basename(handle.paths.socket)}.`);
  await new Promise<void>((resolveStop) => {
    const stop = () => void handle.close().finally(resolveStop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    void handle.closed.then(resolveStop);
  });
}
