import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { buildPolarbearLaunchSpec, resolveAgentRuntime, type AgentLaunchSpec, type AgentRuntime } from "../../platform/agent-launch.js";
import type { ProjectBinding } from "../../platform/project.js";

const CONFIG_FILE = join(".codex", "config.toml");
const MANAGED_BEGIN = "# BEGIN POLARBEAR MEMORY MANAGED MCP";
const MANAGED_END = "# END POLARBEAR MEMORY MANAGED MCP";
const SERVER_HEADER = /^\s*\[mcp_servers\.(?:polarbear-memory|"polarbear-memory")\]\s*(?:#.*)?$/mu;

export type CodexConfigurationClassification =
  | "CURRENT_MANAGED"
  | "LEGACY_MANAGED"
  | "REPAIRABLE_POLARBEAR"
  | "FOREIGN_COLLISION";

export interface CodexIntegrationPlan {
  configPath: string;
  backupRequired: boolean;
  alreadyInstalled: boolean;
  conflict: boolean;
  classification: CodexConfigurationClassification | null;
  migrationRequired: boolean;
}

export interface CodexUninstallPlan {
  managedEntry: boolean;
}

interface BackupManifest {
  version: 1;
  createdAt: string;
  config: string | null;
}

function assertSafeConfigPath(projectRoot: string): string {
  const directory = join(projectRoot, ".codex");
  const path = join(projectRoot, CONFIG_FILE);
  if (existsSync(directory) && !lstatSync(directory).isDirectory()) {
    throw new Error(`Refusing to use non-directory Codex configuration path: ${directory}`);
  }
  if (existsSync(path) && !lstatSync(path).isFile()) {
    throw new Error(`Refusing to modify non-regular file: ${path}`);
  }
  return path;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function launchSpec(project: ProjectBinding, runtime: AgentRuntime): AgentLaunchSpec {
  return buildPolarbearLaunchSpec(runtime, ["mcp", "--stdio", "--project-root", project.root]);
}

function managedBlock(spec: AgentLaunchSpec): string {
  const args = spec.args.map((value) => JSON.stringify(value)).join(", ");
  return `${MANAGED_BEGIN}\n[mcp_servers.polarbear-memory]\ncommand = ${JSON.stringify(spec.command)}\nargs = [${args}]\nrequired = true\n${MANAGED_END}`;
}

function managedRange(content: string): { start: number; end: number } | null {
  const start = content.indexOf(MANAGED_BEGIN);
  const endMarker = content.indexOf(MANAGED_END);
  if (start === -1 && endMarker === -1) return null;
  if (start === -1 || endMarker === -1 || endMarker < start) {
    throw new Error("Codex configuration contains an incomplete Polarbear Memory managed block.");
  }
  const duplicateStart = content.indexOf(MANAGED_BEGIN, start + MANAGED_BEGIN.length);
  const duplicateEnd = content.indexOf(MANAGED_END, endMarker + MANAGED_END.length);
  if (duplicateStart !== -1 || duplicateEnd !== -1) {
    throw new Error("Codex configuration contains multiple Polarbear Memory managed blocks.");
  }
  let end = endMarker + MANAGED_END.length;
  if (content[end] === "\r" && content[end + 1] === "\n") end += 2;
  else if (content[end] === "\n") end += 1;
  return { start, end };
}

function serverRange(content: string): { start: number; end: number; body: string } | null {
  const match = SERVER_HEADER.exec(content);
  if (!match || match.index === undefined) return null;
  const start = match.index;
  const afterHeader = start + match[0].length;
  const nextHeader = /^\s*\[[^\n]+\]\s*(?:#.*)?$/gmu;
  nextHeader.lastIndex = afterHeader;
  const next = nextHeader.exec(content);
  const end = next?.index ?? content.length;
  return { start, end, body: content.slice(start, end) };
}

function parseTomlString(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseLaunchSpec(body: string): AgentLaunchSpec | undefined {
  const commandMatch = /^\s*command\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/mu.exec(body);
  const argsMatch = /^\s*args\s*=\s*(\[[\s\S]*?\])\s*(?:#.*)?$/mu.exec(body);
  if (!commandMatch?.[1] || !argsMatch?.[1]) return undefined;
  const command = parseTomlString(commandMatch[1]);
  try {
    const args: unknown = JSON.parse(argsMatch[1]);
    if (command === undefined || !Array.isArray(args) || !args.every((value) => typeof value === "string")) return undefined;
    return { command, args } as AgentLaunchSpec;
  } catch {
    return undefined;
  }
}

function hasPolarbearMcpArguments(args: string[], offset = 0): boolean {
  return args.length === offset + 4
    && args[offset] === "mcp"
    && args[offset + 1] === "--stdio"
    && args[offset + 2] === "--project-root"
    && Boolean(args[offset + 3]);
}

function classifyCodexConfiguration(
  content: string,
  runtime: AgentRuntime,
): CodexConfigurationClassification | null {
  if (managedRange(content)) return "CURRENT_MANAGED";
  const server = serverRange(content);
  if (!server) return null;
  const spec = parseLaunchSpec(server.body);
  if (spec?.command === "polarbear-memory" && hasPolarbearMcpArguments(spec.args)) return "LEGACY_MANAGED";
  if (spec && isAbsolute(spec.command) && spec.args[0] === runtime.cliEntrypoint && hasPolarbearMcpArguments(spec.args, 1)) {
    return "REPAIRABLE_POLARBEAR";
  }
  return "FOREIGN_COLLISION";
}

function desiredConfig(
  existing: string | null,
  project: ProjectBinding,
  spec: AgentLaunchSpec,
  classification: CodexConfigurationClassification | null,
): string {
  const block = `${managedBlock(spec)}\n`;
  if (existing === null || existing.trim() === "") return block;
  if (classification === "CURRENT_MANAGED") {
    const range = managedRange(existing);
    if (!range) throw new Error("Codex managed configuration classification is inconsistent.");
    return `${existing.slice(0, range.start)}${block}${existing.slice(range.end)}`;
  }
  if (classification === "LEGACY_MANAGED" || classification === "REPAIRABLE_POLARBEAR") {
    const range = serverRange(existing);
    if (!range) throw new Error("Codex migration configuration classification is inconsistent.");
    return `${existing.slice(0, range.start)}${block}${existing.slice(range.end)}`;
  }
  if (classification === "FOREIGN_COLLISION") {
    throw new Error("Codex already has an unmanaged `polarbear-memory` MCP server. Remove or rename it before installing.");
  }
  return `${existing.trimEnd()}\n\n${block}`;
}

function removeManagedConfig(existing: string | null): { content: string | null; removed: boolean } {
  if (existing === null) return { content: null, removed: false };
  const range = managedRange(existing);
  if (!range) return { content: existing, removed: false };
  const content = `${existing.slice(0, range.start)}${existing.slice(range.end)}`.trimEnd();
  return { content: content ? `${content}\n` : "", removed: true };
}

function backup(project: ProjectBinding, current: string | null, category: "codex" | "uninstall"): string {
  const backupDir = join(project.dataDir, "backups", category, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), config: current };
  atomicWrite(join(backupDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return backupDir;
}

export function planCodexIntegration(project: ProjectBinding, runtime: AgentRuntime = resolveAgentRuntime()): CodexIntegrationPlan {
  const configPath = assertSafeConfigPath(project.root);
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const spec = launchSpec(project, runtime);
  const classification = current === null ? null : classifyCodexConfiguration(current, runtime);
  const conflict = classification === "FOREIGN_COLLISION";
  return {
    configPath,
    backupRequired: current !== null,
    alreadyInstalled: classification === "CURRENT_MANAGED"
      && current !== null
      && current === desiredConfig(current, project, spec, classification),
    conflict,
    classification,
    migrationRequired: classification === "LEGACY_MANAGED" || classification === "REPAIRABLE_POLARBEAR",
  };
}

export function installCodexIntegration(
  project: ProjectBinding,
  options: { dryRun: boolean; runtime?: AgentRuntime },
): { plan: CodexIntegrationPlan; backupDir?: string } {
  const runtime = options.runtime ?? resolveAgentRuntime();
  const plan = planCodexIntegration(project, runtime);
  if (plan.conflict) {
    throw new Error("Codex already has an unmanaged `polarbear-memory` MCP server. Remove or rename it before installing.");
  }
  if (options.dryRun || plan.alreadyInstalled) return { plan };
  const current = existsSync(plan.configPath) ? readFileSync(plan.configPath, "utf8") : null;
  const backupDir = backup(project, current, "codex");
  atomicWrite(plan.configPath, desiredConfig(current, project, launchSpec(project, runtime), plan.classification));
  return { plan, backupDir };
}

export function readCodexLaunchSpec(project: ProjectBinding): AgentLaunchSpec | undefined {
  const path = assertSafeConfigPath(project.root);
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, "utf8");
  const managed = managedRange(content);
  const body = managed ? content.slice(managed.start, managed.end) : serverRange(content)?.body;
  return body ? parseLaunchSpec(body) : undefined;
}

export function uninstallCodexIntegration(
  project: ProjectBinding,
  options: { dryRun: boolean },
): { plan: CodexUninstallPlan; backupDir?: string } {
  const configPath = assertSafeConfigPath(project.root);
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const next = removeManagedConfig(current);
  const plan = { managedEntry: next.removed };
  if (options.dryRun || !next.removed || next.content === null) return { plan };
  const backupDir = backup(project, current, "uninstall");
  atomicWrite(configPath, next.content);
  return { plan, backupDir };
}
