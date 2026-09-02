import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { LifecycleOrchestrator } from "../../application/lifecycle-orchestrator.js";
import type { AgentLifecycleOutcome } from "../../domain/agent-lifecycle.js";
import { AGENT_LIFECYCLE_EVENT_TYPES, type AgentLifecycleEvent } from "../../domain/agent-lifecycle.js";
import type { ProjectBinding } from "../../platform/project.js";
import { readProjectPolicy } from "../../platform/project.js";
import { SqliteMemoryStore } from "../../storage/sqlite-store.js";
import { CodexAppServerGateway, type LifecycleEventHandler } from "./app-server-gateway.js";

function disabledOutcome(): AgentLifecycleOutcome {
  return { accepted: false, observations: 0, candidates: 0, persisted: 0 };
}

const CODEX_SPOOL_FILE_LIMIT = 512;
const APP_SERVER_FRAME_LIMIT = 1024 * 1024;

function codexSpoolDirectory(project: ProjectBinding): string {
  return join(project.dataDir, "spool", "codex-app-server");
}

function writeCodexSpool(project: ProjectBinding, event: AgentLifecycleEvent): boolean {
  const directory = codexSpoolDirectory(project);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${event.id}.json`);
  if (existsSync(target)) return true;
  const queued = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name)).length;
  if (queued >= CODEX_SPOOL_FILE_LIMIT) return false;
  const durableEvent = { ...event, currentRequest: undefined };
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(durableEvent)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
  return true;
}

function parseSpoolEvent(value: unknown): AgentLifecycleEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex lifecycle spool event.");
  const event = value as Partial<AgentLifecycleEvent>;
  if (typeof event.id !== "string" || !/^[a-f0-9]{64}$/u.test(event.id)
    || event.provider !== "codex-app-server"
    || !AGENT_LIFECYCLE_EVENT_TYPES.includes(event.type as AgentLifecycleEvent["type"])
    || typeof event.sessionRefHash !== "string" || !/^[a-f0-9]{64}$/u.test(event.sessionRefHash)
    || typeof event.occurredAt !== "string" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)
    || !Object.values(event.payload).every((item) => typeof item === "string" || typeof item === "boolean")) {
    throw new Error("Invalid Codex lifecycle spool event.");
  }
  return event as AgentLifecycleEvent;
}

function replayCodexSpool(project: ProjectBinding, handler: LifecycleOrchestrator): void {
  const directory = codexSpoolDirectory(project);
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      const event = parseSpoolEvent(JSON.parse(readFileSync(path, "utf8")));
      handler.handle(event);
      handler.recordMetric(event, "SPOOLED");
      handler.recordMetric(event, "REPLAYED");
      unlinkSync(path);
    } catch {
      // Keep valid retryable entries and leave invalid entries for bounded diagnostics.
    }
  }
}

async function writeLine(stream: Writable, line: string): Promise<void> {
  if (!stream.write(`${line}\n`)) await once(stream, "drain");
}

function parseMessage(line: string): unknown | undefined {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

async function* boundedLines(stream: Readable): AsyncGenerator<string> {
  stream.setEncoding("utf8");
  let pending = "";
  for await (const chunk of stream) {
    pending += chunk as string;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/u, "");
      if (Buffer.byteLength(line, "utf8") > APP_SERVER_FRAME_LIMIT) {
        throw new Error("Codex App Server JSONL frame exceeds the 1 MiB limit.");
      }
      yield line;
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending, "utf8") > APP_SERVER_FRAME_LIMIT) {
      throw new Error("Codex App Server JSONL frame exceeds the 1 MiB limit.");
    }
  }
  if (pending.length > 0) yield pending.replace(/\r$/u, "");
}

export async function runCodexAppServerProcess(options: {
  project: ProjectBinding;
  codexCommand: string;
  preferredTaskId?: string;
}): Promise<void> {
  const policy = readProjectPolicy(options.project.configPath);
  let store: SqliteMemoryStore | undefined;
  let handler: LifecycleEventHandler = { handle: disabledOutcome };
  if (policy.captureMode !== "off" && policy.captureMode !== "manual") {
    try {
      store = new SqliteMemoryStore(options.project.databasePath, { busyTimeoutMs: 100 });
      store.initializeProject(options.project);
      const orchestrator = new LifecycleOrchestrator(store.contextOs(), options.project.id);
      replayCodexSpool(options.project, orchestrator);
      handler = orchestrator;
    } catch {
      store?.close();
      store = undefined;
      handler = { handle: () => { throw new Error("Lifecycle storage is unavailable."); } };
    }
  }
  const gateway = new CodexAppServerGateway(handler, {
    ...(options.preferredTaskId ? { preferredTaskId: options.preferredTaskId } : {}),
    ...(policy.contextBudgetMode === "custom" ? { contextBudget: policy.defaultContextBudget } : {}),
    ...(policy.captureMode !== "off" && policy.captureMode !== "manual"
      ? { onFailure: (event: AgentLifecycleEvent) => { writeCodexSpool(options.project, event); } }
      : {}),
  });
  const launchPath = [...new Set([
    dirname(process.execPath), dirname(options.codexCommand), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
  ])].join(delimiter);
  const child = spawn(options.codexCommand, ["app-server", "--listen", "stdio://"], {
    cwd: options.project.root,
    env: { ...process.env, PATH: launchPath },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const forwardSignal = (signal: NodeJS.Signals) => { if (!child.killed) child.kill(signal); };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  child.stderr.on("data", (chunk: Buffer | string) => process.stderr.write(chunk));

  const clientPump = (async () => {
    try {
      for await (const line of boundedLines(process.stdin)) {
        const parsed = parseMessage(line);
        const transformed = parsed === undefined ? undefined : gateway.transformClientMessage(parsed);
        await writeLine(child.stdin, transformed === undefined || transformed === parsed ? line : JSON.stringify(transformed));
      }
    } catch (error) {
      if (!child.killed) child.kill();
      throw error;
    } finally {
      child.stdin.end();
    }
  })();
  const serverPump = (async () => {
    try {
      for await (const line of boundedLines(child.stdout)) {
        const parsed = parseMessage(line);
        if (parsed !== undefined) gateway.observeServerMessage(parsed);
        await writeLine(process.stdout, line);
      }
    } catch (error) {
      if (!child.killed) child.kill();
      throw error;
    }
  })();
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      process.stdin.destroy();
      resolve(code ?? (signal ? 1 : 0));
    });
  });

  try {
    const [exitCode] = await Promise.all([exited, clientPump, serverPump]);
    if (exitCode !== 0) throw new Error(`Codex App Server exited with status ${exitCode}.`);
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    store?.close();
  }
}
