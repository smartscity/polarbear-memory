import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join } from "node:path";
import type { GitContext } from "./git.js";

const CONFIG_RELATIVE_PATH = join(".polarbear", "config.toml");

export interface ProjectBinding {
  id: string;
  name: string;
  root: string;
  configPath: string;
  dataDir: string;
  databasePath: string;
}

export type CaptureMode = "off" | "manual" | "summary";
export type ContextBudgetMode = "auto" | "custom";
export interface ProjectPolicy {
  captureMode: CaptureMode;
  rawEventRetentionDays: number;
  contextBudgetMode: ContextBudgetMode;
  defaultContextBudget: number;
}

export function readProjectPolicy(configPath: string): ProjectPolicy {
  const text = readFileSync(configPath, "utf8");
  const capture = /^capture_mode\s*=\s*"([^"]+)"\s*$/im.exec(text)?.[1] ?? "manual";
  if (capture !== "off" && capture !== "manual" && capture !== "summary") {
    throw new Error("capture_mode must be off, manual, or summary; diagnostic requires user-level authorization.");
  }
  const retention = Number(/^raw_event_retention_days\s*=\s*(\d+)\s*$/im.exec(text)?.[1] ?? "30");
  const budgetMatch = /^default_context_budget\s*=\s*(\d+)\s*$/im.exec(text);
  const budgetMode = /^context_budget_mode\s*=\s*"([^"]+)"\s*$/im.exec(text)?.[1]
    ?? (budgetMatch ? "custom" : "auto");
  const budget = Number(budgetMatch?.[1] ?? "2000");
  if (!Number.isInteger(retention) || retention < 0 || retention > 30) throw new Error("raw_event_retention_days must be 0–30.");
  if (budgetMode !== "auto" && budgetMode !== "custom") throw new Error("context_budget_mode must be auto or custom.");
  if (!Number.isInteger(budget) || budget < 200 || budget > 12_000) throw new Error("default_context_budget must be 200–12000.");
  return {
    captureMode: capture,
    rawEventRetentionDays: retention,
    contextBudgetMode: budgetMode,
    defaultContextBudget: budget,
  };
}

export function updateProjectPolicy(configPath: string, update: {
  captureMode?: CaptureMode;
  rawEventRetentionDays?: number;
  contextBudgetMode?: ContextBudgetMode;
  defaultContextBudget?: number;
}): ProjectPolicy {
  const current = readProjectPolicy(configPath);
  const next = { ...current, ...update };
  if (!Number.isInteger(next.rawEventRetentionDays) || next.rawEventRetentionDays < 0 || next.rawEventRetentionDays > 30) {
    throw new Error("raw_event_retention_days must be 0–30.");
  }
  if (next.contextBudgetMode !== "auto" && next.contextBudgetMode !== "custom") {
    throw new Error("context_budget_mode must be auto or custom.");
  }
  if (!Number.isInteger(next.defaultContextBudget) || next.defaultContextBudget < 200 || next.defaultContextBudget > 12_000) {
    throw new Error("default_context_budget must be 200–12000.");
  }
  let text = readFileSync(configPath, "utf8");
  text = /^capture_mode\s*=.*$/im.test(text)
    ? text.replace(/^capture_mode\s*=.*$/im, `capture_mode = "${next.captureMode}"`)
    : `${text.trimEnd()}\ncapture_mode = "${next.captureMode}"\n`;
  text = /^raw_event_retention_days\s*=.*$/im.test(text)
    ? text.replace(/^raw_event_retention_days\s*=.*$/im, `raw_event_retention_days = ${next.rawEventRetentionDays}`)
    : `${text.trimEnd()}\nraw_event_retention_days = ${next.rawEventRetentionDays}\n`;
  text = /^context_budget_mode\s*=.*$/im.test(text)
    ? text.replace(/^context_budget_mode\s*=.*$/im, `context_budget_mode = "${next.contextBudgetMode}"`)
    : `${text.trimEnd()}\ncontext_budget_mode = "${next.contextBudgetMode}"\n`;
  text = /^default_context_budget\s*=.*$/im.test(text)
    ? text.replace(/^default_context_budget\s*=.*$/im, `default_context_budget = ${next.defaultContextBudget}`)
    : `${text.trimEnd()}\ndefault_context_budget = ${next.defaultContextBudget}\n`;
  const temporary = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, configPath);
  return readProjectPolicy(configPath);
}

export function defaultDataRoot(): string {
  const override = process.env.POLARBEAR_MEMORY_DATA_DIR;
  if (override) return override;
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Polarbear Memory");
  if (platform() === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Polarbear Memory");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "polarbear-memory");
}

function readProjectId(configPath: string): string {
  const text = readFileSync(configPath, "utf8");
  const match = /^project_id\s*=\s*"([0-9a-f-]{36})"\s*$/im.exec(text);
  if (!match?.[1]) throw new Error(`Invalid or missing project_id in ${configPath}`);
  return match[1];
}

function binding(git: GitContext, id: string): ProjectBinding {
  const dataDir = join(defaultDataRoot(), "projects", id);
  return {
    id,
    name: basename(git.root),
    root: git.root,
    configPath: join(git.root, CONFIG_RELATIVE_PATH),
    dataDir,
    databasePath: join(dataDir, "memory.db"),
  };
}

export function planProject(git: GitContext): ProjectBinding {
  const configPath = join(git.root, CONFIG_RELATIVE_PATH);
  return binding(git, existsSync(configPath) ? readProjectId(configPath) : randomUUID());
}

export function loadProject(git: GitContext): ProjectBinding {
  const configPath = join(git.root, CONFIG_RELATIVE_PATH);
  if (!existsSync(configPath)) throw new Error("Project is not initialized. Run `polarbear-memory init` first.");
  return binding(git, readProjectId(configPath));
}

export function writeProjectConfig(project: ProjectBinding): void {
  mkdirSync(join(project.root, ".polarbear"), { recursive: true, mode: 0o700 });
  if (!existsSync(project.configPath)) {
    writeFileSync(
      project.configPath,
      `schema_version = 1\nproject_id = "${project.id}"\ncapture_mode = "summary"\nraw_event_retention_days = 30\ncontext_budget_mode = "auto"\ndefault_context_budget = 2000\n\n[security]\nnetwork = "disabled"\nremote_resources = "deny"\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  }
  mkdirSync(project.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(project.dataDir, "backups"), { recursive: true, mode: 0o700 });
  mkdirSync(join(project.dataDir, "diagnostics"), { recursive: true, mode: 0o700 });
  mkdirSync(join(project.dataDir, "spool"), { recursive: true, mode: 0o700 });
}
