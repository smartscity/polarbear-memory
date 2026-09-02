import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { compileContext } from "../application/context.js";
import { runMaintenance } from "../application/maintenance.js";
import { planClaudeIntegration, readClaudeLaunchSpec } from "../adapters/claude-code/integration.js";
import { planCodexIntegration, readCodexLaunchSpec } from "../adapters/codex/integration.js";
import { planCodexAppServerIntegration, readCodexAppServerLaunchSpec } from "../adapters/codex/app-server-integration.js";
import { parseMemoryType } from "../domain/memory.js";
import { captureFileAnchors } from "../platform/anchors.js";
import { discoverGitContext, normalizeRepoFile } from "../platform/git.js";
import { loadProject } from "../platform/project.js";
import { CURRENT_SCHEMA_VERSION, SqliteMemoryStore } from "../storage/sqlite-store.js";
import { VERSION } from "../version.js";
import {
  minimalAgentEnvironment, probeCodexAppServerLaunch, probeMcpLaunch, resolveAgentRuntime, sanitizeAgentDiagnostic, validateAgentLaunchSpec,
  type AgentLaunchSpec,
} from "../platform/agent-launch.js";
import { diagnoseRuntimeLaunchDescriptor } from "../platform/runtime-descriptor.js";

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

export function record(cwd: string, args: string[]): void {
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

export function search(cwd: string, args: string[]): void {
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

export function get(cwd: string, args: string[]): void {
  if (args.length !== 1 || !args[0]) throw new Error("get requires exactly one memory ID.");
  withStore(cwd, (store, project) => {
    const memory = store.get(project.id, args[0] as string);
    if (!memory) throw new Error(`Memory not found: ${args[0]}`);
    console.log(JSON.stringify(memory, null, 2));
  });
}

export function context(cwd: string, args: string[]): void {
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

export function status(cwd: string): void {
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

function printTokenSavings(stats: ReturnType<SqliteMemoryStore["tokenSavings"]>): void {
  const number = new Intl.NumberFormat("en-US");
  const rate = stats.baselineTokens > 0
    ? ((stats.estimatedSavedTokens / stats.baselineTokens) * 100).toFixed(1)
    : "0.0";
  console.log(`Estimated tokens saved  ${number.format(stats.estimatedSavedTokens)}`);
  console.log(`Candidate baseline      ${number.format(stats.baselineTokens)}`);
  console.log(`Context tokens delivered ${number.format(stats.contextTokens)}`);
  console.log(`Estimated saving rate   ${rate}%`);
  console.log(`Context packs           ${number.format(stats.contextPackCount)}`);
  console.log(`Candidates / selected   ${number.format(stats.candidateCount)} / ${number.format(stats.selectedCount)}`);
  console.log(`Measurement started     ${stats.measurementStartedAt}`);
  console.log(`Last context            ${stats.lastContextAt ?? "never"}`);
  console.log(`Reset count             ${number.format(stats.resetCount)}`);
  console.log("Method                  candidate-baseline-v1 (estimated, local only)");
}

export function savings(cwd: string, args: string[]): void {
  const action = args[0] ?? "show";
  if (action === "show" && args.length <= 1) {
    return withStore(cwd, (store, project) => printTokenSavings(store.tokenSavings(project.id)));
  }
  if (action !== "reset") throw new Error("savings accepts `show` or `reset --confirm RESET`.");
  const parsed = parseArgs({ args: args.slice(1), options: { confirm: { type: "string" } }, strict: true });
  if (parsed.values.confirm !== "RESET") throw new Error("savings reset requires --confirm RESET.");
  withStore(cwd, (store, project) => {
    const result = store.resetTokenSavings(project.id, new Date().toISOString());
    console.log("Token savings counters reset. Historical Memory was not changed.\n");
    printTokenSavings(result);
  });
}

export function verify(cwd: string, args: string[]): void {
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

export function restore(cwd: string, args: string[]): void {
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

export function complete(cwd: string, args: string[]): void {
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

export function relate(cwd: string, args: string[]): void {
  const parsed = parseArgs({
    args,
    options: { type: { type: "string" }, target: { type: "string" }, reason: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const source = parsed.positionals[0];
  const type = parsed.values.type?.toUpperCase();
  const relationTypes = ["SUPERSEDES", "CONTRADICTS", "EXTENDS", "DERIVES", "DEPENDS_ON", "RELATED_TO"] as const;
  if (parsed.positionals.length !== 1 || !source || !parsed.values.target || !parsed.values.reason
    || !relationTypes.includes(type as (typeof relationTypes)[number])) {
    throw new Error("relate requires SOURCE_ID, a supported --type, --target TARGET_ID and --reason.");
  }
  withStore(cwd, (store, project) => {
    store.addRelation(project.id, source, parsed.values.target as string, type as (typeof relationTypes)[number], parsed.values.reason as string);
    console.log(`Recorded ${type} relation from ${source} to ${parsed.values.target}.`);
  });
}

export function feedback(cwd: string, args: string[]): void {
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

export function maintain(cwd: string, args: string[]): void {
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

export function forget(cwd: string, args: string[]): void {
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

async function reportAgentIntegration(
  label: string,
  configStatus: "OK" | "STALE" | "CONFLICT" | "NOT INSTALLED",
  spec: AgentLaunchSpec | undefined,
  projectRoot: string,
): Promise<{ configured: boolean; executable: boolean; handshake: boolean; healthy: boolean }> {
  const prefix = label.padEnd(10);
  console.log(`${prefix} config       ${configStatus}`);
  if (!spec) {
    console.log(`${prefix} executable   NOT CONFIGURED`);
    console.log(`${prefix} handshake    NOT RUN`);
    return {
      configured: false, executable: false, handshake: false,
      healthy: configStatus === "NOT INSTALLED",
    };
  }
  const validation = validateAgentLaunchSpec(spec);
  console.log(`${prefix} executable   ${validation.ok ? "OK" : "FAILED"}`);
  if (!validation.ok) {
    console.log(`  ${sanitizeAgentDiagnostic(validation.detail)}`);
    console.log("  Run: polarbear-memory install");
    console.log(`${prefix} handshake    NOT RUN`);
    return { configured: configStatus === "OK", executable: false, handshake: false, healthy: false };
  }
  const probe = await probeMcpLaunch(spec, { cwd: projectRoot, env: minimalAgentEnvironment() });
  console.log(`${prefix} handshake    ${probe.ok ? "OK" : "FAILED"}`);
  if (!probe.ok) {
    console.log(`  ${probe.kind}: ${sanitizeAgentDiagnostic(probe.detail)}`);
    console.log("  Run: polarbear-memory install");
  }
  return {
    configured: configStatus === "OK", executable: true, handshake: probe.ok,
    healthy: configStatus === "OK" && probe.ok,
  };
}

export async function doctor(cwd: string, args: string[]): Promise<void> {
  const parsed = parseArgs({ args, options: { export: { type: "boolean", default: false } }, strict: true });
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
  const runtimeDescriptor = diagnoseRuntimeLaunchDescriptor(resolveAgentRuntime());
  for (const [label, result] of [
    ["Runtime descriptor", runtimeDescriptor.descriptor],
    ["Runtime executable", runtimeDescriptor.executable],
    ["CLI entrypoint", runtimeDescriptor.cliEntrypoint],
  ] as const) {
    console.log(`${label.padEnd(24)} ${result.ok ? "OK" : "FAILED"}`);
    if (!result.ok) console.log(`  ${sanitizeAgentDiagnostic(result.detail)}`);
  }
  if (!runtimeDescriptor.current) console.log("  Run: polarbear-memory install");
  const integration = planClaudeIntegration(project);
  const codexIntegration = planCodexIntegration(project);
  const codexAppServerIntegration = planCodexAppServerIntegration(project);
  const claudeSpec = readClaudeLaunchSpec(project);
  const codexSpec = readCodexLaunchSpec(project);
  const codexAppServerSpec = readCodexAppServerLaunchSpec(project);
  const claudeStatus = integration.alreadyInstalled ? "OK" : claudeSpec ? "STALE" : "NOT INSTALLED";
  const codexStatus = codexIntegration.alreadyInstalled
    ? "OK"
    : codexIntegration.conflict ? "CONFLICT" : codexSpec ? "STALE" : "NOT INSTALLED";
  const claudeDiagnostics = await reportAgentIntegration("Claude MCP", claudeStatus, claudeSpec, project.root);
  const codexDiagnostics = await reportAgentIntegration("Codex MCP", codexStatus, codexSpec, project.root);
  const codexAppServerValidation = codexAppServerSpec ? validateAgentLaunchSpec(codexAppServerSpec) : undefined;
  const codexAppServerProbe = codexAppServerIntegration.alreadyInstalled && codexAppServerSpec && codexAppServerValidation?.ok
    ? await probeCodexAppServerLaunch(codexAppServerSpec, { cwd: project.root, env: minimalAgentEnvironment() })
    : undefined;
  const codexAppServerReady = codexAppServerProbe?.ok ?? false;
  console.log(`Claude lifecycle          ${integration.alreadyInstalled ? "LIFECYCLE_MANAGED" : "UNAVAILABLE"}`);
  console.log(`Claude lifecycle events   ${integration.alreadyInstalled ? "OK" : "NOT CONFIGURED"}`);
  console.log(`Claude prompt injection   ${integration.alreadyInstalled ? "OK" : "NOT CONFIGURED"}`);
  console.log(`Claude event spool        ${integration.alreadyInstalled ? "OK" : "NOT CONFIGURED"}`);
  console.log(`Codex lifecycle mode      ${codexIntegration.alreadyInstalled ? "MCP_ASSISTED" : "UNAVAILABLE"}`);
  console.log(`Codex App Server adapter  ${codexAppServerReady ? "LIFECYCLE_MANAGED" : codexAppServerIntegration.conflict ? "CONFLICT" : codexAppServerProbe ? "HANDSHAKE_FAILED" : codexAppServerIntegration.alreadyInstalled ? "INVALID" : "NOT_INSTALLED"}`);
  if (codexAppServerValidation && !codexAppServerValidation.ok) console.log(`  ${sanitizeAgentDiagnostic(codexAppServerValidation.detail)}`);
  if (codexAppServerProbe && !codexAppServerProbe.ok) console.log(`  ${codexAppServerProbe.kind}: ${sanitizeAgentDiagnostic(codexAppServerProbe.detail)}`);
  if (!runtimeDescriptor.current || !claudeDiagnostics.healthy || !codexDiagnostics.healthy
    || (codexAppServerIntegration.alreadyInstalled && !codexAppServerReady)) process.exitCode = 1;
  console.log("Network      disabled by design");
  if (parsed.values.export) {
    const diagnosticsDirectory = join(project.dataDir, "diagnostics");
    mkdirSync(diagnosticsDirectory, { recursive: true, mode: 0o700 });
    const path = join(diagnosticsDirectory, `doctor-${new Date().toISOString().replaceAll(":", "-")}.json`);
    const statusCounts = withStore(cwd, (store, current) => store.status(current.id));
    const report = {
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      engineVersion: VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      runtime: process.version,
      platform: { os: platform(), release: release(), arch: process.arch },
      projectRef: createHash("sha256").update(project.id).digest("hex").slice(0, 16),
      repository: { branchPresent: Boolean(git.branch), headPresent: Boolean(git.head) },
      counts: statusCounts,
      integrations: {
        claudeInstalled: claudeDiagnostics.configured,
        claudeExecutable: claudeDiagnostics.executable,
        claudeHandshake: claudeDiagnostics.handshake,
        claudeMode: integration.alreadyInstalled ? "LIFECYCLE_MANAGED" : "UNAVAILABLE",
        codexInstalled: codexDiagnostics.configured,
        codexExecutable: codexDiagnostics.executable,
        codexHandshake: codexDiagnostics.handshake,
        codexMode: codexIntegration.alreadyInstalled ? "MCP_ASSISTED" : "UNAVAILABLE",
        codexLifecycle: "UNSUPPORTED",
        codexAppServerInstalled: codexAppServerIntegration.alreadyInstalled,
        codexAppServerExecutable: codexAppServerValidation?.ok ?? false,
        codexAppServerHandshake: codexAppServerProbe?.ok ?? false,
        codexAppServerMode: codexAppServerReady ? "LIFECYCLE_MANAGED" : "UNAVAILABLE",
        codexConflict: codexIntegration.conflict,
      },
      runtimeDescriptor: {
        current: runtimeDescriptor.current,
        descriptor: runtimeDescriptor.descriptor.ok,
        executable: runtimeDescriptor.executable.ok,
        cliEntrypoint: runtimeDescriptor.cliEntrypoint.ok,
      },
      networkPolicy: "disabled",
    };
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    console.log(`Diagnostics  ${path}`);
    console.log("Diagnostics contain no Memory content, repository path, commit, branch name, environment, or database path.");
  }
}
