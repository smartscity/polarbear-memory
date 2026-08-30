import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  assertAgentLaunchFile,
  buildPolarbearLaunchSpec,
  validateAgentLaunchSpec,
  type AgentRuntime,
} from "./agent-launch.js";
import { defaultDataRoot } from "./project.js";

interface RuntimeDescriptorContract {
  contract: string;
  schemaVersion: number;
  relativePath: string[];
  runtimeFields: string[];
}

const contract = loadRuntimeDescriptorContract();
export const RUNTIME_DESCRIPTOR_SCHEMA_VERSION = contract.schemaVersion;

export interface RuntimeLaunchDescriptor {
  schemaVersion: number;
  runtime: AgentRuntime;
}

export interface RuntimeDescriptorDiagnosis {
  path: string;
  current: boolean;
  descriptor: { ok: boolean; detail: string };
  executable: { ok: boolean; detail: string };
  cliEntrypoint: { ok: boolean; detail: string };
}

export interface RuntimeDescriptorPlan {
  action: "CURRENT" | "CREATE" | "REPAIR";
  path: string;
}

export interface RuntimeDescriptorEnsureResult {
  action: "CURRENT" | "CREATED" | "REPAIRED";
  path: string;
}

export function managedRuntimeDescriptorPath(dataRoot = defaultDataRoot()): string {
  return join(dataRoot, ...contract.relativePath);
}

export function createRuntimeLaunchDescriptor(runtime: AgentRuntime): RuntimeLaunchDescriptor {
  const launch = validateAgentLaunchSpec(buildPolarbearLaunchSpec(runtime, []));
  if (!launch.ok) throw new Error(`Cannot publish Polarbear runtime descriptor: ${launch.detail}`);
  return { schemaVersion: RUNTIME_DESCRIPTOR_SCHEMA_VERSION, runtime };
}

export function publishRuntimeLaunchDescriptor(runtime: AgentRuntime, dataRoot = defaultDataRoot()): string {
  const descriptor = createRuntimeLaunchDescriptor(runtime);
  const path = managedRuntimeDescriptorPath(dataRoot);
  writeRuntimeLaunchDescriptor(path, descriptor);
  return path;
}

export function diagnoseRuntimeLaunchDescriptor(
  expectedRuntime: AgentRuntime,
  dataRoot = defaultDataRoot(),
): RuntimeDescriptorDiagnosis {
  const path = managedRuntimeDescriptorPath(dataRoot);
  let descriptor: RuntimeLaunchDescriptor;
  try {
    descriptor = readRuntimeLaunchDescriptor(dataRoot);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      path,
      current: false,
      descriptor: { ok: false, detail },
      executable: { ok: false, detail: "Runtime executable is unavailable because the descriptor could not be read." },
      cliEntrypoint: { ok: false, detail: "CLI entrypoint is unavailable because the descriptor could not be read." },
    };
  }
  const executable = validateDescriptorFile(descriptor.runtime.executable, "Runtime executable", true);
  const cliEntrypoint = validateDescriptorFile(descriptor.runtime.cliEntrypoint, "CLI entrypoint", false);
  const matchesExpected = descriptor.runtime.executable === expectedRuntime.executable
    && descriptor.runtime.cliEntrypoint === expectedRuntime.cliEntrypoint;
  return {
    path,
    current: matchesExpected && executable.ok && cliEntrypoint.ok,
    descriptor: matchesExpected
      ? { ok: true, detail: "Runtime descriptor matches the active package runtime." }
      : { ok: false, detail: "Runtime descriptor does not match the active package runtime." },
    executable,
    cliEntrypoint,
  };
}

export function planRuntimeLaunchDescriptor(
  runtime: AgentRuntime,
  dataRoot = defaultDataRoot(),
): RuntimeDescriptorPlan {
  const diagnosis = diagnoseRuntimeLaunchDescriptor(runtime, dataRoot);
  if (diagnosis.current) return { action: "CURRENT", path: diagnosis.path };
  try {
    readFileSync(diagnosis.path, "utf8");
    return { action: "REPAIR", path: diagnosis.path };
  } catch {
    return { action: "CREATE", path: diagnosis.path };
  }
}

export function ensureRuntimeLaunchDescriptor(
  runtime: AgentRuntime,
  dataRoot = defaultDataRoot(),
): RuntimeDescriptorEnsureResult {
  const plan = planRuntimeLaunchDescriptor(runtime, dataRoot);
  if (plan.action === "CURRENT") return { action: "CURRENT", path: plan.path };
  publishRuntimeLaunchDescriptor(runtime, dataRoot);
  return { action: plan.action === "CREATE" ? "CREATED" : "REPAIRED", path: plan.path };
}

function writeRuntimeLaunchDescriptor(path: string, descriptor: RuntimeLaunchDescriptor): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
}

export function readRuntimeLaunchDescriptor(dataRoot = defaultDataRoot()): RuntimeLaunchDescriptor {
  const path = managedRuntimeDescriptorPath(dataRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`Polarbear runtime descriptor is unavailable: ${path}`);
  }
  return parseRuntimeLaunchDescriptor(parsed);
}

function parseRuntimeLaunchDescriptor(value: unknown): RuntimeLaunchDescriptor {
  if (!value || typeof value !== "object") throw new Error("Polarbear runtime descriptor must be an object.");
  const descriptor = value as { schemaVersion?: unknown; runtime?: { executable?: unknown; cliEntrypoint?: unknown } };
  if (descriptor.schemaVersion !== RUNTIME_DESCRIPTOR_SCHEMA_VERSION) {
    throw new Error(`Unsupported Polarbear runtime descriptor schema: ${String(descriptor.schemaVersion)}.`);
  }
  const executable = descriptor.runtime?.executable;
  const cliEntrypoint = descriptor.runtime?.cliEntrypoint;
  if (typeof executable !== "string" || !isAbsolute(executable)) {
    throw new Error("Polarbear runtime descriptor contains an invalid executable path.");
  }
  if (typeof cliEntrypoint !== "string" || !isAbsolute(cliEntrypoint)) {
    throw new Error("Polarbear runtime descriptor contains an invalid CLI entrypoint path.");
  }
  return { schemaVersion: RUNTIME_DESCRIPTOR_SCHEMA_VERSION, runtime: { executable, cliEntrypoint } };
}

function validateDescriptorFile(path: string, label: string, executable: boolean): { ok: boolean; detail: string } {
  try {
    assertAgentLaunchFile(path, label, executable);
    return { ok: true, detail: `${label} is available.` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function loadRuntimeDescriptorContract(): RuntimeDescriptorContract {
  const path = new URL("../../api/runtime-launch-v1.json", import.meta.url);
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeDescriptorContract>;
  if (value.contract !== "polarbear-memory-runtime-launch"
    || !Number.isInteger(value.schemaVersion)
    || !Array.isArray(value.relativePath)
    || value.relativePath.length === 0
    || value.relativePath.some((part) => typeof part !== "string" || !part || part === "." || part === ".." || part.includes("/") || part.includes("\\"))
    || !Array.isArray(value.runtimeFields)
    || value.runtimeFields.join(",") !== "executable,cliEntrypoint") {
    throw new Error("Invalid Polarbear runtime descriptor contract.");
  }
  return value as RuntimeDescriptorContract;
}
