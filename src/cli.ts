#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compileContext } from "./application/context.js";
import { runMaintenance } from "./application/maintenance.js";
import { runBenchmark } from "./application/benchmark.js";
import { planClaudeIntegration, uninstallClaudeIntegration } from "./adapters/claude-code/integration.js";
import { uninstallCodexIntegration } from "./adapters/codex/integration.js";
import { runClaudeCommand, runHookCommand, runSpoolCommand } from "./cli/claude-commands.js";
import { runInstallCommand } from "./cli/install-command.js";
import {
  complete, context, doctor, feedback, forget, get, maintain,
  record, relate, restore, savings, search, status, verify,
} from "./cli/memory-commands.js";
import { parseMemoryType } from "./domain/memory.js";
import { discoverGitContext, normalizeRepoFile } from "./platform/git.js";
import { captureFileAnchors } from "./platform/anchors.js";
import { defaultDataRoot, loadProject, planProject, writeProjectConfig } from "./platform/project.js";
import { CURRENT_SCHEMA_VERSION, SqliteMemoryStore } from "./storage/sqlite-store.js";
import { inspectBackup, listBackups, restoreBackup } from "./application/recovery.js";
import { VERSION } from "./version.js";
import {
  checkpointCommand, contextOsCommand, managedRunCommand, metricsCommand, taskCommand,
} from "./cli/context-os-commands.js";

function usage(): string {
  return `Polarbear Memory ${VERSION}

Usage:
  polarbear-memory install [--dry-run]
  polarbear-memory init [--dry-run]
  polarbear-memory record --type TYPE --summary TEXT [--content TEXT] [--file PATH...]
  polarbear-memory search QUERY [--limit N]
  polarbear-memory get MEMORY_ID
  polarbear-memory context --task TEXT [--budget N]
  polarbear-memory task create --title TEXT --objective TEXT [--phase PHASE]
  polarbear-memory task status [TASK_ID]
  polarbear-memory context build --request TEXT [--task TASK_ID] [--budget N] [--provider NAME]
  polarbear-memory context explain PACKET_ID
  polarbear-memory checkpoint --task TASK_ID --summary TEXT [--state FILE.json]
  polarbear-memory metrics [--task TASK_ID]
  polarbear-memory run --provider codex|claude-code --task TASK_ID [--model MODEL] [--resume SESSION_ID|--fresh] [--writable] "REQUEST"
  polarbear-memory verify MEMORY_ID --result STATE --reason TEXT
  polarbear-memory forget MEMORY_ID --reason TEXT
  polarbear-memory restore MEMORY_ID --reason TEXT
  polarbear-memory complete MEMORY_ID --result completed|cancelled --reason TEXT
  polarbear-memory feedback MEMORY_ID --result useful|not-useful --reason TEXT
  polarbear-memory relate SOURCE_ID --type supersedes|contradicts|extends|derives|depends_on|related_to --target TARGET_ID --reason TEXT
  polarbear-memory maintain [--dry-run] [--limit N]
  polarbear-memory status
  polarbear-memory savings [show|reset --confirm RESET]
  polarbear-memory doctor [--export]
  polarbear-memory mcp --stdio [--project-root PATH] [--admin-tools]
  polarbear-memory service run
  polarbear-memory claude install [--dry-run] [--command EXECUTABLE]
  polarbear-memory claude restore
  polarbear-memory hook ingest --event SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|PreCompact|PostCompact|Stop|SessionEnd
  polarbear-memory spool replay
  polarbear-memory rebuild-index
  polarbear-memory backup [create|list|verify FILE|restore FILE --confirm FILE]
  polarbear-memory uninstall [--dry-run] [--keep-data|--delete-data --confirm PROJECT_ID]
  polarbear-memory benchmark FIXTURE.json
`;
}

function withStore<T>(cwd: string, action: (store: SqliteMemoryStore, project: ReturnType<typeof loadProject>) => T): T {
  const git = discoverGitContext(cwd);
  const project = loadProject(git);
  const store = new SqliteMemoryStore(project.databasePath);
  try {
    store.initializeProject(project);
    return action(store, project);
  } finally {
    store.close();
  }
}

function init(cwd: string, args: string[]): void {
  const parsed = parseArgs({ args, options: { "dry-run": { type: "boolean", default: false } }, strict: true });
  const git = discoverGitContext(cwd);
  const project = planProject(git);
  console.log(`Repository: ${project.name}`);
  console.log(`Branch: ${git.branch ?? "detached"}`);
  console.log(`HEAD: ${git.head?.slice(0, 12) ?? "no commits"}`);
  console.log(`Config: ${project.configPath}`);
  console.log(parsed.values["dry-run"] && !existsSync(project.configPath)
    ? "Database: new project data directory (ID assigned on init)"
    : `Database: ${project.databasePath}`);
  if (parsed.values["dry-run"]) {
    console.log("\nDry run only; no files were changed.");
    return;
  }
  writeProjectConfig(project);
  const store = new SqliteMemoryStore(project.databasePath);
  try {
    store.initializeProject(project);
  } finally {
    store.close();
  }
  console.log("\nPolarbear Memory is ready (summary capture mode).");
}

function benchmark(cwd: string, args: string[]): void {
  if (args.length !== 1 || !args[0]) throw new Error("benchmark requires one fixture JSON path.");
  const git = discoverGitContext(cwd);
  const project = loadProject(git);
  const store = new SqliteMemoryStore(":memory:");
  try {
    store.initializeProject(project);
    const result = runBenchmark(store, project.id, args[0], project.root);
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } finally {
    store.close();
  }
}

async function createBackup(cwd: string): Promise<string> {
  const git = discoverGitContext(cwd);
  const project = loadProject(git);
  const destination = join(project.dataDir, "backups", `memory-${new Date().toISOString().replaceAll(":", "-")}.db`);
  const store = new SqliteMemoryStore(project.databasePath);
  try {
    const pages = await store.backup(destination);
    console.log(`Backup created: ${destination}`);
    console.log(`Pages copied: ${pages}`);
    return destination;
  } finally {
    store.close();
  }
}

async function backupCommand(cwd: string, args: string[]): Promise<void> {
  const [action = "create", ...rest] = args;
  if (action === "create" && rest.length === 0) {
    await createBackup(cwd);
    return;
  }
  const project = loadProject(discoverGitContext(cwd));
  if (action === "list" && rest.length === 0) {
    const backups = listBackups(project);
    if (backups.length === 0) return console.log("No database backups found.");
    for (const item of backups) console.log(`${item.fileName}\tschema=${item.schemaVersion}\tbytes=${item.bytes}\tsha256=${item.sha256}\tintegrity=${item.integrity}`);
    return;
  }
  if (action === "verify" && rest.length === 1 && rest[0]) {
    console.log(JSON.stringify(inspectBackup(project, rest[0]), null, 2));
    return;
  }
  if (action === "restore") {
    const parsed = parseArgs({ args: rest, options: { confirm: { type: "string" } }, allowPositionals: true, strict: true });
    const input = parsed.positionals[0];
    if (parsed.positionals.length !== 1 || !input) throw new Error("backup restore requires exactly one backup file.");
    const inspection = inspectBackup(project, input);
    if (parsed.values.confirm !== inspection.fileName) {
      console.log(JSON.stringify(inspection, null, 2));
      console.log(`Dry run only. Re-run with --confirm ${inspection.fileName} to replace the operational database.`);
      return;
    }
    const result = restoreBackup(project, input);
    console.log(`Restored ${result.restored.fileName} after integrity and schema validation.`);
    if (result.rollbackPath) console.log(`Previous database preserved at ${result.rollbackPath}`);
    return;
  }
  throw new Error("backup requires create, list, verify FILE, or restore FILE [--confirm FILE].");
}

function uninstall(cwd: string, args: string[]): void {
  const parsed = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean", default: false },
      "keep-data": { type: "boolean", default: false },
      "delete-data": { type: "boolean", default: false },
      confirm: { type: "string" },
    },
    strict: true,
  });
  if (parsed.values["keep-data"] && parsed.values["delete-data"]) throw new Error("Choose either --keep-data or --delete-data.");
  const project = loadProject(discoverGitContext(cwd));
  const result = uninstallClaudeIntegration(project, { dryRun: parsed.values["dry-run"] });
  const codex = uninstallCodexIntegration(project, { dryRun: parsed.values["dry-run"] });
  console.log(`Claude MCP entry: ${result.plan.mcpEntry ? "remove" : "unchanged"}`);
  console.log(`Claude hooks: ${result.plan.hooks} managed entries to remove`);
  console.log(`Claude rule: ${result.plan.managedRule ? "remove" : result.plan.modifiedRulePreserved ? "preserve modified file" : "unchanged"}`);
  console.log(`Codex MCP entry: ${codex.plan.managedEntry ? "remove" : "unchanged"}`);
  if (parsed.values["dry-run"]) return console.log("Dry run only; no files were changed.");
  if (result.backupDir) console.log(`Integration backup: ${result.backupDir}`);
  if (codex.backupDir) console.log(`Codex integration backup: ${codex.backupDir}`);
  if (!parsed.values["delete-data"]) return console.log(`Project data preserved at ${project.dataDir}`);
  if (parsed.values.confirm !== project.id) {
    console.log(`Data deletion was not performed. Re-run with --delete-data --confirm ${project.id}`);
    return;
  }
  if (!existsSync(project.dataDir) || !lstatSync(project.dataDir).isDirectory()) return console.log("Project data is already absent.");
  const trashRoot = join(defaultDataRoot(), "trash");
  mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
  const destination = join(trashRoot, `${project.id}-${new Date().toISOString().replaceAll(":", "-")}`);
  renameSync(project.dataDir, destination);
  console.log(`Project data moved to recoverable trash: ${destination}`);
  console.log("Repository configuration and promoted Markdown were preserved.");
}

async function mcp(cwd: string, args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      stdio: { type: "boolean", default: false },
      "project-root": { type: "string" },
      "admin-tools": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!parsed.values.stdio) throw new Error("MVP-1 supports only `mcp --stdio`.");
  const root = parsed.values["project-root"] ?? cwd;
  const git = discoverGitContext(root);
  const project = loadProject(git);
  const store = new SqliteMemoryStore(project.databasePath);
  store.initializeProject(project);
  process.once("exit", () => store.close());
  const { serveMemoryMcpStdio } = await import("./protocol-mcp/server.js");
  await serveMemoryMcpStdio({ store, project, includeAdminTools: parsed.values["admin-tools"] });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const cwd = process.cwd();
  if (!command || command === "help" || command === "--help" || command === "-h") return console.log(usage());
  if (command === "--version" || command === "version") return console.log(VERSION);
  switch (command) {
    case "install": return runInstallCommand(cwd, args);
    case "init": return init(cwd, args);
    case "record": return record(cwd, args);
    case "search": return search(cwd, args);
    case "get": return get(cwd, args);
    case "context": return args[0] === "build" || args[0] === "explain" ? contextOsCommand(cwd, args) : context(cwd, args);
    case "task": return taskCommand(cwd, args);
    case "checkpoint": return checkpointCommand(cwd, args);
    case "metrics": return metricsCommand(cwd, args);
    case "run": return managedRunCommand(cwd, args);
    case "verify": return verify(cwd, args);
    case "forget": return forget(cwd, args);
    case "restore": return restore(cwd, args);
    case "complete": return complete(cwd, args);
    case "feedback": return feedback(cwd, args);
    case "relate": return relate(cwd, args);
    case "maintain": return maintain(cwd, args);
    case "status": return status(cwd);
    case "savings": return savings(cwd, args);
    case "doctor": return doctor(cwd, args);
    case "rebuild-index": return withStore(cwd, (store) => { store.rebuildSearchIndex(); console.log("Search index rebuilt."); });
    case "backup": return backupCommand(cwd, args);
    case "uninstall": return uninstall(cwd, args);
    case "benchmark": return benchmark(cwd, args);
    case "mcp": return mcp(cwd, args);
    case "service": {
      if (args.length !== 1 || args[0] !== "run") throw new Error("service requires `run`.");
      const { serveAdminApi } = await import("./protocol-local/server.js");
      return serveAdminApi();
    }
    case "claude": return runClaudeCommand(cwd, args);
    case "hook": return runHookCommand(cwd, args);
    case "spool": return runSpoolCommand(cwd, args);
    default: throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}
