import { randomUUID } from "node:crypto";
import { constants, accessSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { buildPolarbearLaunchSpec, resolveAgentRuntime, type AgentLaunchSpec, type AgentRuntime } from "../../platform/agent-launch.js";
import type { ProjectBinding } from "../../platform/project.js";

const DESCRIPTOR_PATH = join(".codex", "polarbear-app-server.json");

export interface CodexAppServerDescriptor {
  version: 1;
  mode: "LIFECYCLE_MANAGED";
  transport: "stdio";
  command: string;
  args: string[];
  codexCommand: string;
  projectRoot: string;
}

export interface CodexAppServerIntegrationPlan {
  descriptorPath: string;
  alreadyInstalled: boolean;
  conflict: boolean;
  descriptor?: CodexAppServerDescriptor;
}

function descriptorPath(project: ProjectBinding): string {
  const directory = join(project.root, ".codex");
  const path = join(project.root, DESCRIPTOR_PATH);
  if (existsSync(directory) && !lstatSync(directory).isDirectory()) throw new Error(`Refusing to use non-directory Codex configuration path: ${directory}`);
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`Refusing to modify non-regular file: ${path}`);
  return path;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function assertCodexCommand(command: string): void {
  if (!isAbsolute(command)) throw new Error("The managed Codex App Server command must be an absolute path.");
  if (!existsSync(command) || !lstatSync(command).isFile()) throw new Error(`Codex executable does not exist: ${command}`);
  accessSync(command, constants.X_OK);
}

function desiredDescriptor(project: ProjectBinding, runtime: AgentRuntime, codexCommand: string): CodexAppServerDescriptor {
  assertCodexCommand(codexCommand);
  const launch = buildPolarbearLaunchSpec(runtime, [
    "codex", "app-server", "run", "--project-root", project.root, "--codex-command", codexCommand,
  ]);
  return {
    version: 1,
    mode: "LIFECYCLE_MANAGED",
    transport: "stdio",
    command: launch.command,
    args: launch.args,
    codexCommand,
    projectRoot: project.root,
  };
}

function parseDescriptor(content: string): CodexAppServerDescriptor | undefined {
  try {
    const value = JSON.parse(content) as Partial<CodexAppServerDescriptor>;
    if (value.version !== 1 || value.mode !== "LIFECYCLE_MANAGED" || value.transport !== "stdio"
      || typeof value.command !== "string" || !isAbsolute(value.command)
      || !Array.isArray(value.args) || !value.args.every((item) => typeof item === "string")
      || typeof value.codexCommand !== "string" || !isAbsolute(value.codexCommand)
      || typeof value.projectRoot !== "string" || !isAbsolute(value.projectRoot)) return undefined;
    return value as CodexAppServerDescriptor;
  } catch {
    return undefined;
  }
}

function backup(project: ProjectBinding, content: string | null): string {
  const directory = join(project.dataDir, "backups", "codex-app-server", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicWrite(join(directory, "manifest.json"), `${JSON.stringify({ version: 1, content }, null, 2)}\n`);
  return directory;
}

export function planCodexAppServerIntegration(
  project: ProjectBinding,
  options: { runtime?: AgentRuntime; codexCommand?: string } = {},
): CodexAppServerIntegrationPlan {
  const path = descriptorPath(project);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  const descriptor = current === null ? undefined : parseDescriptor(current);
  if (!options.codexCommand) {
    return {
      descriptorPath: path,
      alreadyInstalled: descriptor?.projectRoot === project.root,
      conflict: current !== null && !descriptor,
      ...(descriptor ? { descriptor } : {}),
    };
  }
  const desired = desiredDescriptor(project, options.runtime ?? resolveAgentRuntime(), options.codexCommand);
  const desiredContent = `${JSON.stringify(desired, null, 2)}\n`;
  return {
    descriptorPath: path,
    alreadyInstalled: current === desiredContent,
    conflict: current !== null && !descriptor,
    ...(descriptor ? { descriptor } : {}),
  };
}

export function installCodexAppServerIntegration(
  project: ProjectBinding,
  options: { codexCommand: string; dryRun: boolean; runtime?: AgentRuntime },
): { plan: CodexAppServerIntegrationPlan; backupDir?: string } {
  const runtime = options.runtime ?? resolveAgentRuntime();
  const plan = planCodexAppServerIntegration(project, { runtime, codexCommand: options.codexCommand });
  if (plan.conflict) throw new Error("Refusing to overwrite an unmanaged Codex App Server descriptor.");
  if (options.dryRun || plan.alreadyInstalled) return { plan };
  const current = existsSync(plan.descriptorPath) ? readFileSync(plan.descriptorPath, "utf8") : null;
  const backupDir = backup(project, current);
  atomicWrite(plan.descriptorPath, `${JSON.stringify(desiredDescriptor(project, runtime, options.codexCommand), null, 2)}\n`);
  return { plan, backupDir };
}

export function readCodexAppServerLaunchSpec(project: ProjectBinding): AgentLaunchSpec | undefined {
  const plan = planCodexAppServerIntegration(project);
  return plan.alreadyInstalled && plan.descriptor
    ? { command: plan.descriptor.command, args: plan.descriptor.args }
    : undefined;
}

export function readCodexAppServerProviderLaunchSpec(project: ProjectBinding): AgentLaunchSpec | undefined {
  const plan = planCodexAppServerIntegration(project);
  return plan.alreadyInstalled && plan.descriptor
    ? { command: plan.descriptor.codexCommand, args: ["app-server", "--listen", "stdio://"] }
    : undefined;
}

export function uninstallCodexAppServerIntegration(
  project: ProjectBinding,
  options: { dryRun: boolean },
): { managedDescriptor: boolean; backupDir?: string } {
  const path = descriptorPath(project);
  if (!existsSync(path)) return { managedDescriptor: false };
  const content = readFileSync(path, "utf8");
  if (!parseDescriptor(content)) return { managedDescriptor: false };
  if (options.dryRun) return { managedDescriptor: true };
  const backupDir = backup(project, content);
  unlinkSync(path);
  return { managedDescriptor: true, backupDir };
}
