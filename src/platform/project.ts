import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
      `schema_version = 1\nproject_id = "${project.id}"\ncapture_mode = "manual"\ndefault_context_budget = 1000\n\n[security]\nnetwork = "disabled"\nremote_resources = "deny"\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  }
  mkdirSync(project.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(project.dataDir, "backups"), { recursive: true, mode: 0o700 });
  mkdirSync(join(project.dataDir, "diagnostics"), { recursive: true, mode: 0o700 });
  mkdirSync(join(project.dataDir, "spool"), { recursive: true, mode: 0o700 });
}
