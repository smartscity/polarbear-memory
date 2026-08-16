#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compileContext } from "./application/context.js";
import { runMaintenance } from "./application/maintenance.js";
import { runBenchmark } from "./application/benchmark.js";
import { installClaudeIntegration, planClaudeIntegration, restoreLatestClaudeIntegration } from "./adapter-claude-code/integration.js";
import { parseMemoryType } from "./domain/memory.js";
import { discoverGitContext, normalizeRepoFile } from "./platform/git.js";
import { captureFileAnchors } from "./platform/anchors.js";
import { loadProject, planProject, writeProjectConfig } from "./platform/project.js";
import { SqliteMemoryStore } from "./storage/sqlite-store.js";

const VERSION = "0.0.4";

function usage(): string {
  return `Polarbear Memory ${VERSION}

Usage:
  polarbear-memory init [--dry-run]
  polarbear-memory record --type TYPE --summary TEXT [--content TEXT] [--file PATH...]
  polarbear-memory search QUERY [--limit N]
  polarbear-memory get MEMORY_ID
  polarbear-memory context --task TEXT [--budget N]
  polarbear-memory verify MEMORY_ID --result STATE --reason TEXT
  polarbear-memory forget MEMORY_ID --reason TEXT
  polarbear-memory restore MEMORY_ID --reason TEXT
  polarbear-memory complete MEMORY_ID --result completed|cancelled --reason TEXT
  polarbear-memory feedback MEMORY_ID --result useful|not-useful --reason TEXT
  polarbear-memory relate SOURCE_ID --type supersedes|contradicts --target TARGET_ID --reason TEXT
  polarbear-memory maintain [--dry-run] [--limit N]
  polarbear-memory status
  polarbear-memory doctor
  polarbear-memory mcp --stdio [--project-root PATH] [--admin-tools]
  polarbear-memory claude install [--dry-run] [--command EXECUTABLE]
  polarbear-memory claude restore
  polarbear-memory hook ingest --event Stop|SessionEnd
  polarbear-memory spool replay
  polarbear-memory rebuild-index
  polarbear-memory backup
  polarbear-memory benchmark FIXTURE.json
`;
}

function parseNumber(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isInteger(result)) throw new Error(`${label} must be an integer.`);
  return result;
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
  console.log("\nPolarbear Memory is ready (manual capture mode).");
}

function record(cwd: string, args: string[]): void {
  const parsed = parseArgs({
    args,
    options: {
      type: { type: "string", short: "t" },
      summary: { type: "string", short: "s" },
      content: { type: "string", short: "c" },
      file: { type: "string", short: "f", multiple: true },
      confidence: { type: "string" },
      importance: { type: "string" },
    },
    strict: true,
  });
  if (!parsed.values.type || !parsed.values.summary) throw new Error("record requires --type and --summary.");
  const git = discoverGitContext(cwd);
  const project = loadProject(git);
  const files = (parsed.values.file ?? []).map((file) => normalizeRepoFile(project.root, file));
  const store = new SqliteMemoryStore(project.databasePath);
  try {
    store.initializeProject(project);
    const memory = store.record(project.id, {
      type: parseMemoryType(parsed.values.type),
      summary: parsed.values.summary,
      ...(parsed.values.content ? { content: parsed.values.content } : {}),
      ...(files.length > 0 ? { files } : {}),
      ...(files.length > 0 ? { fileAnchors: captureFileAnchors(project.root, files, git.head) } : {}),
      ...(git.head ? { commitSha: git.head } : {}),
      ...(git.branch ? { branchName: git.branch } : {}),
      confidence: parseNumber(parsed.values.confidence, 700, "confidence"),
      importance: parseNumber(parsed.values.importance, 500, "importance"),
    });
    console.log(`Recorded ${memory.type} ${memory.id}`);
    console.log(memory.summary);
  } finally {
    store.close();
  }
}

function search(cwd: string, args: string[]): void {
  const parsed = parseArgs({ args, options: { limit: { type: "string", short: "n" } }, allowPositionals: true, strict: true });
  const query = parsed.positionals.join(" ").trim();
  if (!query) throw new Error("search requires a query.");
  withStore(cwd, (store, project) => {
    const results = store.search(project.id, query, parseNumber(parsed.values.limit, 10, "limit"));
    if (results.length === 0) return console.log("No matching memory found.");
    for (const { memory } of results) {
      console.log(`${memory.id}\t${memory.type}\t${memory.correctnessRisk}\t${memory.summary}`);
    }
  });
}

function get(cwd: string, args: string[]): void {
  if (args.length !== 1 || !args[0]) throw new Error("get requires exactly one memory ID.");
  withStore(cwd, (store, project) => {
    const memory = store.get(project.id, args[0] as string);
    if (!memory) throw new Error(`Memory not found: ${args[0]}`);
    console.log(JSON.stringify(memory, null, 2));
  });
}

function context(cwd: string, args: string[]): void {
  const parsed = parseArgs({
    args,
    options: { task: { type: "string", short: "t" }, budget: { type: "string", short: "b" } },
    strict: true,
  });
  if (!parsed.values.task) throw new Error("context requires --task.");
  withStore(cwd, (store, project) => {
    const git = discoverGitContext(project.root);
    try {
      runMaintenance(store, project.id, project.root, {
        dryRun: false,
        limit: 100,
        ...(git.head ? { head: git.head } : {}),
      });
    } catch {
      // Bounded maintenance is best-effort and must not block context retrieval.
    }
    const result = compileContext(store, project.id, parsed.values.task as string, parseNumber(parsed.values.budget, 1000, "budget"));
    process.stdout.write(result.markdown);
    console.error(`Context: ${result.selected} memories, ~${result.estimatedTokens} tokens`);
  });
}

function status(cwd: string): void {
  withStore(cwd, (store, project) => {
    const counts = store.status(project.id);
    console.log(`Project   ${project.name}`);
    console.log(`Database  ${project.databasePath}`);
    console.log(`Total     ${counts.total ?? 0}`);
    console.log(`Active    ${counts.active ?? 0}`);
    console.log(`Archived  ${counts.archived ?? 0}`);
    console.log(`Stale     ${counts.high_risk ?? 0}`);
    console.log(`Completed ${counts.completed ?? 0}`);
  });
}

function verify(cwd: string, args: string[]): void {
  const parsed = parseArgs({
    args,
    options: { result: { type: "string" }, reason: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const memoryId = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !memoryId || !parsed.values.result || !parsed.values.reason) {
    throw new Error("verify requires MEMORY_ID, --result and --reason.");
  }
  if (!(["VERIFIED", "DISPUTED", "UNVERIFIED"] as string[]).includes(parsed.values.result)) {
    throw new Error("verify --result must be VERIFIED, DISPUTED or UNVERIFIED.");
  }
  withStore(cwd, (store, project) => {
    const git = discoverGitContext(project.root);
    const current = store.get(project.id, memoryId);
    if (!current) throw new Error(`Memory not found: ${memoryId}`);
    const memory = store.verify(
      project.id,
      memoryId,
      parsed.values.result as "VERIFIED" | "DISPUTED" | "UNVERIFIED",
      parsed.values.reason as string,
      "HUMAN_CLI",
      { anchors: captureFileAnchors(project.root, current.files, git.head), ...(git.head ? { checkedCommit: git.head } : {}) },
    );
    console.log(`Memory ${memory.id} is ${memory.verificationState}.`);
  });
}

function restore(cwd: string, args: string[]): void {
  const parsed = parseArgs({ args, options: { reason: { type: "string" } }, allowPositionals: true, strict: true });
  const memoryId = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !memoryId || !parsed.values.reason) {
    throw new Error("restore requires MEMORY_ID and --reason.");
  }
  withStore(cwd, (store, project) => {
    const memory = store.restore(project.id, memoryId, parsed.values.reason as string);
    console.log(`Memory ${memory.id} restored with a 30-day automatic-archive grace period.`);
  });
}

function complete(cwd: string, args: string[]): void {
  const parsed = parseArgs({
    args,
    options: { result: { type: "string" }, reason: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const memoryId = parsed.positionals[0];
  const result = parsed.values.result?.toUpperCase();
  if (parsed.positionals.length !== 1 || !memoryId || !result || !parsed.values.reason
    || (result !== "COMPLETED" && result !== "CANCELLED")) {
    throw new Error("complete requires MEMORY_ID, --result completed|cancelled and --reason.");
  }
  withStore(cwd, (store, project) => {
    const memory = store.complete(project.id, memoryId, result, parsed.values.reason as string);
    console.log(`Memory ${memory.id} is ${memory.completionState} and has left normal Context.`);
  });
}

function relate(cwd: string, args: string[]): void {
  const parsed = parseArgs({
    args,
    options: { type: { type: "string" }, target: { type: "string" }, reason: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const source = parsed.positionals[0];
  const type = parsed.values.type?.toUpperCase();
  if (parsed.positionals.length !== 1 || !source || !parsed.values.target || !parsed.values.reason
    || (type !== "SUPERSEDES" && type !== "CONTRADICTS")) {
    throw new Error("relate requires SOURCE_ID, --type supersedes|contradicts, --target TARGET_ID and --reason.");
  }
  withStore(cwd, (store, project) => {
    store.addRelation(project.id, source, parsed.values.target as string, type, parsed.values.reason as string);
    console.log(`Recorded ${type} relation from ${source} to ${parsed.values.target}.`);
  });
}

function feedback(cwd: string, args: string[]): void {
  const parsed = parseArgs({
    args,
    options: { result: { type: "string" }, reason: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const memoryId = parsed.positionals[0];
  const result = parsed.values.result?.toLowerCase();
  if (parsed.positionals.length !== 1 || !memoryId || !parsed.values.reason
    || (result !== "useful" && result !== "not-useful")) {
    throw new Error("feedback requires MEMORY_ID, --result useful|not-useful and --reason.");
  }
  withStore(cwd, (store, project) => {
    const memory = store.noteFeedback(project.id, memoryId, result === "useful", parsed.values.reason as string);
    console.log(`Recorded ${result} feedback for ${memory.id}.`);
  });
}

function maintain(cwd: string, args: string[]): void {
  const parsed = parseArgs({
    args,
    options: { "dry-run": { type: "boolean", default: false }, limit: { type: "string" } },
    strict: true,
  });
  const git = discoverGitContext(cwd);
  withStore(cwd, (store, project) => {
    const plan = runMaintenance(store, project.id, project.root, {
      dryRun: parsed.values["dry-run"],
      limit: parseNumber(parsed.values.limit, 200, "limit"),
      ...(git.head ? { head: git.head } : {}),
    });
    console.log(JSON.stringify(plan, null, 2));
  });
}

function forget(cwd: string, args: string[]): void {
  const parsed = parseArgs({ args, options: { reason: { type: "string" } }, allowPositionals: true, strict: true });
  const memoryId = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !memoryId || !parsed.values.reason) {
    throw new Error("forget requires MEMORY_ID and --reason.");
  }
  withStore(cwd, (store, project) => {
    const memory = store.archive(project.id, memoryId, parsed.values.reason as string, "HUMAN_CLI");
    console.log(`Memory ${memory.id} archived; no physical data was purged.`);
  });
}

function doctor(cwd: string): void {
  const git = discoverGitContext(cwd);
  const project = loadProject(git);
  console.log(`Polarbear Memory ${VERSION}`);
  console.log(`Runtime      ${Number(process.versions.node.split(".")[0]) >= 24 ? "OK" : "UNSUPPORTED"} (${process.version})`);
  console.log(`Data dir     ${existsSync(project.dataDir) ? "OK" : "MISSING"}`);
  withStore(cwd, (store, current) => {
    store.search(current.id, "capability", 1);
    console.log("SQLite       OK");
    console.log("FTS5         OK");
  });
  console.log("Git          OK");
  const integration = planClaudeIntegration(project);
  console.log(`Claude MCP   ${integration.alreadyInstalled ? "OK" : "NOT INSTALLED"}`);
  console.log("Network      disabled by design");
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

async function createBackup(cwd: string): Promise<void> {
  const git = discoverGitContext(cwd);
  const project = loadProject(git);
  const destination = join(project.dataDir, "backups", `memory-${new Date().toISOString().replaceAll(":", "-")}.db`);
  const store = new SqliteMemoryStore(project.databasePath);
  try {
    const pages = await store.backup(destination);
    console.log(`Backup created: ${destination}`);
    console.log(`Pages copied: ${pages}`);
  } finally {
    store.close();
  }
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

function claude(cwd: string, args: string[]): void {
  const [action, ...rest] = args;
  const git = discoverGitContext(cwd);
  const project = loadProject(git);
  if (action === "install") {
    const parsed = parseArgs({
      args: rest,
      options: { "dry-run": { type: "boolean", default: false }, command: { type: "string" } },
      strict: true,
    });
    const result = installClaudeIntegration(project, {
      dryRun: parsed.values["dry-run"],
      ...(parsed.values.command ? { command: parsed.values.command } : {}),
    });
    console.log(`MCP config: ${result.plan.mcpPath}`);
    console.log(`Rule:       ${result.plan.rulePath}`);
    console.log(`Hooks:      ${result.plan.settingsPath}`);
    if (result.plan.alreadyInstalled) console.log("Claude Code integration is already installed.");
    else if (parsed.values["dry-run"]) console.log("Dry run only; no files were changed.");
    else {
      console.log(`Backup:     ${result.backupDir}`);
      console.log("Claude Code integration installed. Approve the project MCP server when Claude prompts.");
    }
    return;
  }
  if (action === "restore" && rest.length === 0) {
    console.log(`Restored Claude Code integration from ${restoreLatestClaudeIntegration(project)}`);
    return;
  }
  throw new Error("claude requires `install [--dry-run]` or `restore`.");
}

async function readStdinBounded(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("Hook input exceeds the size limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function hook(cwd: string, args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action !== "ingest") return;
  try {
    const parsed = parseArgs({ args: rest, options: { event: { type: "string" } }, strict: true });
    if (parsed.values.event !== "Stop" && parsed.values.event !== "SessionEnd") return;
    const raw: unknown = JSON.parse(await readStdinBounded(256 * 1024));
    if (!raw || typeof raw !== "object" || (raw as { hook_event_name?: unknown }).hook_event_name !== parsed.values.event) return;
    const { ingestClaudeHook } = await import("./adapter-claude-code/hooks.js");
    ingestClaudeHook(raw, cwd);
  } catch {
    // Hooks are observational and must never block Claude Code or write protocol noise.
  }
}

async function spool(cwd: string, args: string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== "replay") throw new Error("spool requires `replay`.");
  const project = loadProject(discoverGitContext(cwd));
  const { replayProjectSpool } = await import("./adapter-claude-code/hooks.js");
  const result = replayProjectSpool(project);
  console.log(`Spool replayed: ${result.replayed}`);
  console.log(`Spool failed:   ${result.failed}`);
  console.log(`Memories:      ${result.finalized}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const cwd = process.cwd();
  if (!command || command === "help" || command === "--help" || command === "-h") return console.log(usage());
  if (command === "--version" || command === "version") return console.log(VERSION);
  switch (command) {
    case "init": return init(cwd, args);
    case "record": return record(cwd, args);
    case "search": return search(cwd, args);
    case "get": return get(cwd, args);
    case "context": return context(cwd, args);
    case "verify": return verify(cwd, args);
    case "forget": return forget(cwd, args);
    case "restore": return restore(cwd, args);
    case "complete": return complete(cwd, args);
    case "feedback": return feedback(cwd, args);
    case "relate": return relate(cwd, args);
    case "maintain": return maintain(cwd, args);
    case "status": return status(cwd);
    case "doctor": return doctor(cwd);
    case "rebuild-index": return withStore(cwd, (store) => { store.rebuildSearchIndex(); console.log("Search index rebuilt."); });
    case "backup": return createBackup(cwd);
    case "benchmark": return benchmark(cwd, args);
    case "mcp": return mcp(cwd, args);
    case "claude": return claude(cwd, args);
    case "hook": return hook(cwd, args);
    case "spool": return spool(cwd, args);
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
