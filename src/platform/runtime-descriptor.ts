import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  buildPolarbearLaunchSpec,
  validateAgentLaunchSpec,
  type AgentRuntime,
} from "./agent-launch.js";
import { defaultDataRoot } from "./project.js";

export const RUNTIME_DESCRIPTOR_SCHEMA_VERSION = 1;

export interface RuntimeLaunchDescriptor {
  schemaVersion: typeof RUNTIME_DESCRIPTOR_SCHEMA_VERSION;
  runtime: AgentRuntime;
}

export function managedRuntimeDescriptorPath(dataRoot = defaultDataRoot()): string {
  return join(dataRoot, "runtime", "launch.json");
}

export function createRuntimeLaunchDescriptor(runtime: AgentRuntime): RuntimeLaunchDescriptor {
  const launch = validateAgentLaunchSpec(buildPolarbearLaunchSpec(runtime, []));
  if (!launch.ok) throw new Error(`Cannot publish Polarbear runtime descriptor: ${launch.detail}`);
  return { schemaVersion: RUNTIME_DESCRIPTOR_SCHEMA_VERSION, runtime };
}

export function publishRuntimeLaunchDescriptor(runtime: AgentRuntime, dataRoot = defaultDataRoot()): string {
  const descriptor = createRuntimeLaunchDescriptor(runtime);
  const path = managedRuntimeDescriptorPath(dataRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
  return path;
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
