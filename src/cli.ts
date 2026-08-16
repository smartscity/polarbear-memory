#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compileContext } from "./application/context.js";
import { runBenchmark } from "./application/benchmark.js";
import { parseMemoryType } from "./domain/memory.js";
import { discoverGitContext, normalizeRepoFile } from "./platform/git.js";
import { loadProject, planProject, writeProjectConfig } from "./platform/project.js";
import { SqliteMemoryStore } from "./storage/sqlite-store.js";

const VERSION = "0.0.1";

function usage(): string {
  return `Polarbear Memory ${VERSION}

Usage:
  polarbear-memory init [--dry-run]
  polarbear-memory record --type TYPE --summary TEXT [--content TEXT] [--file PATH...]
  polarbear-memory search QUERY [--limit N]
  polarbear-memory get MEMORY_ID
  polarbear-memory context --task TEXT [--budget N]
  polarbear-memory status
  polarbear-memory doctor
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
    for (const { memory } of results) console.log(`${memory.id}\t${memory.type}\t${memory.summary}`);
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
  console.log("Network      disabled by design");
}

function benchmark(cwd: string, args: string[]): void {
  if (args.length !== 1 || !args[0]) throw new Error("benchmark requires one fixture JSON path.");
  const git = discoverGitContext(cwd);
  const project = loadProject(git);
  const store = new SqliteMemoryStore(":memory:");
  try {
    store.initializeProject(project);
    const result = runBenchmark(store, project.id, args[0]);
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
    case "status": return status(cwd);
    case "doctor": return doctor(cwd);
    case "rebuild-index": return withStore(cwd, (store) => { store.rebuildSearchIndex(); console.log("Search index rebuilt."); });
    case "backup": return createBackup(cwd);
    case "benchmark": return benchmark(cwd, args);
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
