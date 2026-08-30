import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ProjectBinding } from "../../platform/project.js";

const CONFIG_FILE = join(".codex", "config.toml");
const MANAGED_BEGIN = "# BEGIN POLARBEAR MEMORY MANAGED MCP";
const MANAGED_END = "# END POLARBEAR MEMORY MANAGED MCP";
const SERVER_HEADER = /^\s*\[mcp_servers\.(?:polarbear-memory|"polarbear-memory")\]\s*(?:#.*)?$/mu;

export interface CodexIntegrationPlan {
  configPath: string;
  backupRequired: boolean;
  alreadyInstalled: boolean;
  conflict: boolean;
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

function managedBlock(project: ProjectBinding, command: string): string {
  const args = ["mcp", "--stdio", "--project-root", project.root].map((value) => JSON.stringify(value)).join(", ");
  return `${MANAGED_BEGIN}\n[mcp_servers.polarbear-memory]\ncommand = ${JSON.stringify(command)}\nargs = [${args}]\nrequired = true\n${MANAGED_END}`;
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

function desiredConfig(existing: string | null, project: ProjectBinding, command: string): string {
  const block = `${managedBlock(project, command)}\n`;
  if (existing === null || existing.trim() === "") return block;
  const range = managedRange(existing);
  if (range) return `${existing.slice(0, range.start)}${block}${existing.slice(range.end)}`;
  if (SERVER_HEADER.test(existing)) {
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

export function planCodexIntegration(project: ProjectBinding, command = "polarbear-memory"): CodexIntegrationPlan {
  const configPath = assertSafeConfigPath(project.root);
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const range = current === null ? null : managedRange(current);
  const conflict = range === null && current !== null && SERVER_HEADER.test(current);
  return {
    configPath,
    backupRequired: current !== null,
    alreadyInstalled: !conflict && current !== null && current === desiredConfig(current, project, command),
    conflict,
  };
}

export function installCodexIntegration(
  project: ProjectBinding,
  options: { dryRun: boolean; command?: string },
): { plan: CodexIntegrationPlan; backupDir?: string } {
  const command = options.command ?? "polarbear-memory";
  const plan = planCodexIntegration(project, command);
  if (plan.conflict) {
    throw new Error("Codex already has an unmanaged `polarbear-memory` MCP server. Remove or rename it before installing.");
  }
  if (options.dryRun || plan.alreadyInstalled) return { plan };
  const current = existsSync(plan.configPath) ? readFileSync(plan.configPath, "utf8") : null;
  const backupDir = backup(project, current, "codex");
  atomicWrite(plan.configPath, desiredConfig(current, project, command));
  return { plan, backupDir };
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
