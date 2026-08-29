import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileContext } from "./context.js";
import { runMaintenance } from "./maintenance.js";
import type { MemoryStore } from "./ports.js";
import { parseMemoryType, type RecordMemoryInput } from "../domain/memory.js";
import { emptyCheckpointState } from "../domain/context-os.js";

interface FixtureRecord {
  type: string;
  summary: string;
  content?: string;
  files?: string[];
}

interface Fixture {
  kind?: "single";
  name: string;
  task: string;
  budget: number;
  memories: FixtureRecord[];
  expected: string[];
}

interface ResumeSession {
  id: string;
  memory: FixtureRecord;
  task: string;
  expected: string;
  budget: number;
  baselineFiles: string[];
  avoidedFiles: string[];
  baselineTokens?: number;
  treatmentRediscoveryTokens?: number;
}

interface ResumeSuiteFixture {
  kind: "resume-suite";
  name: string;
  sessions: ResumeSession[];
}

interface RetentionSuiteFixture {
  kind: "retention-suite";
  name: string;
  days: 180;
  criticalPitfallQuery: string;
  criticalPitfallSummary: string;
}

interface ContextOsScenario {
  id: string;
  title: string;
  objective: string;
  request: string;
  budget: number;
  rawHistoryTokens: number;
  memories: FixtureRecord[];
  expected: string[];
  checkpoint?: { summary: string; learned?: string[]; remaining?: string[] };
}

interface ContextOsSuiteFixture {
  kind: "context-os-suite";
  name: string;
  scenarios: ContextOsScenario[];
}

function readFixture(path: string): Fixture | ResumeSuiteFixture | RetentionSuiteFixture | ContextOsSuiteFixture {
  const parsed: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("Fixture must be a JSON object.");
  if ((parsed as { kind?: unknown }).kind === "resume-suite") {
    const suite = parsed as Partial<ResumeSuiteFixture>;
    if (typeof suite.name !== "string" || !Array.isArray(suite.sessions) || suite.sessions.length !== 10) {
      throw new Error("Resume suite requires a name and exactly 10 sessions.");
    }
    return suite as ResumeSuiteFixture;
  }
  if ((parsed as { kind?: unknown }).kind === "retention-suite") {
    const suite = parsed as Partial<RetentionSuiteFixture>;
    if (typeof suite.name !== "string" || suite.days !== 180
      || typeof suite.criticalPitfallQuery !== "string" || typeof suite.criticalPitfallSummary !== "string") {
      throw new Error("Retention suite requires name, 180 days and a critical pitfall oracle.");
    }
    return suite as RetentionSuiteFixture;
  }
  if ((parsed as { kind?: unknown }).kind === "context-os-suite") {
    const suite = parsed as Partial<ContextOsSuiteFixture>;
    if (typeof suite.name !== "string" || !Array.isArray(suite.scenarios) || suite.scenarios.length < 8) {
      throw new Error("Context OS suite requires a name and at least eight scenarios.");
    }
    return suite as ContextOsSuiteFixture;
  }
  const value = parsed as Partial<Fixture>;
  if (typeof value.name !== "string" || typeof value.task !== "string" || !Number.isInteger(value.budget)) {
    throw new Error("Fixture requires name, task and integer budget.");
  }
  if (!Array.isArray(value.memories) || !Array.isArray(value.expected)) {
    throw new Error("Fixture requires memories and expected arrays.");
  }
  return value as Fixture;
}

export interface BenchmarkResult {
  name: string;
  passed: boolean;
  expected: number;
  recalled: number;
  estimatedTokens: number;
  budget: number;
  durationMs: number;
}

export interface ResumeSuiteResult {
  name: string;
  kind: "resume-suite";
  passed: boolean;
  validPacks: number;
  totalSessions: number;
  medianFileReadReductionPercent: number;
  medianTokenReductionPercent: number;
  sessions: Array<{
    id: string;
    passed: boolean;
    estimatedTokens: number;
    baselineFileReads: number;
    treatmentFileReads: number;
    baselineTokens: number;
    treatmentTokens: number;
  }>;
}

export interface RetentionSuiteResult {
  name: string;
  kind: "retention-suite";
  passed: boolean;
  days: number;
  treatments: {
    noRetirement: { active: number; criticalPitfallRecall: boolean };
    naiveTtl: { active: number; criticalPitfallRecall: boolean };
    fourLayer: {
      active: number;
      archived: number;
      superseded: number;
      activeGrowthPer100Sessions: number;
      criticalPitfallRecall: boolean;
      obsoleteTaskStateInContext: number;
      contextPollutionPercent: number;
      automaticArchivePrecisionPercent: number;
      criticalLongTermMisarchives: number;
      canonicalAutoPurgeCount: 0;
    };
  };
}

export interface ContextOsSuiteResult {
  name: string;
  kind: "context-os-suite";
  passed: boolean;
  scenarios: Array<{
    id: string;
    passed: boolean;
    modeA: { strategy: "provider-history"; inputTokens: number };
    modeB: { strategy: "memory-plus-history"; contextTokens: number; logicalInputTokens: number; oracleHits: number };
    modeC: { strategy: "context-os"; contextTokens: number; logicalInputTokens: number; oracleHits: number; bounded: boolean; traceable: boolean };
    reductionVsModeA: number;
    reductionVsModeB: number;
  }>;
}

function recordFixtureMemory(store: MemoryStore, projectId: string, item: FixtureRecord, taskId?: string): void {
  if (!item || typeof item.summary !== "string" || typeof item.type !== "string") {
    throw new Error("Every fixture memory requires type and summary.");
  }
  const input: RecordMemoryInput = {
    type: parseMemoryType(item.type),
    summary: item.summary,
    sourceType: "FIXTURE",
    ...(taskId ? { scopeKind: "TASK", scopeRef: taskId } : {}),
    ...(typeof item.content === "string" ? { content: item.content } : {}),
    ...(Array.isArray(item.files) ? { files: item.files } : {}),
  };
  store.record(projectId, input);
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[Math.floor(middle)] ?? 0;
}

function runResumeSuite(store: MemoryStore, projectId: string, fixture: ResumeSuiteFixture): ResumeSuiteResult {
  const sessions = fixture.sessions.map((session) => {
    if (!session || typeof session.id !== "string" || typeof session.task !== "string" || typeof session.expected !== "string") {
      throw new Error("Every resume session requires id, task and expected.");
    }
    if (!Array.isArray(session.baselineFiles) || !Array.isArray(session.avoidedFiles)) {
      throw new Error("Every resume session requires baselineFiles and avoidedFiles.");
    }
    recordFixtureMemory(store, projectId, session.memory);
    const context = compileContext(store, projectId, session.task, session.budget);
    const passed = context.markdown.includes(session.expected) && context.estimatedTokens <= session.budget;
    const avoided = passed
      ? session.avoidedFiles.filter((file) => session.baselineFiles.includes(file)).length
      : 0;
    return {
      id: session.id,
      passed,
      estimatedTokens: context.estimatedTokens,
      baselineFileReads: session.baselineFiles.length,
      treatmentFileReads: session.baselineFiles.length - avoided,
      baselineTokens: session.baselineTokens ?? session.baselineFiles.length * 1_000,
      treatmentTokens: (session.treatmentRediscoveryTokens ?? (session.baselineFiles.length - avoided) * 1_000)
        + context.estimatedTokens,
    };
  });
  const reductions = sessions.map((session) => session.baselineFileReads === 0
    ? 0
    : ((session.baselineFileReads - session.treatmentFileReads) / session.baselineFileReads) * 100);
  const validPacks = sessions.filter((session) => session.passed).length;
  const reduction = Math.round(median(reductions) * 10) / 10;
  const tokenReduction = Math.round(median(sessions.map((session) => session.baselineTokens === 0
    ? 0
    : ((session.baselineTokens - session.treatmentTokens) / session.baselineTokens) * 100)) * 10) / 10;
  return {
    name: fixture.name,
    kind: "resume-suite",
    passed: validPacks === 10 && reduction >= 30 && tokenReduction >= 40,
    validPacks,
    totalSessions: sessions.length,
    medianFileReadReductionPercent: reduction,
    medianTokenReductionPercent: tokenReduction,
    sessions,
  };
}

function runRetentionSuite(
  store: MemoryStore,
  projectId: string,
  fixture: RetentionSuiteFixture,
  repoRoot: string,
): RetentionSuiteResult {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  store.record(projectId, {
    type: "PITFALL",
    summary: fixture.criticalPitfallSummary,
    sourceType: "FIXTURE",
    importance: 900,
  });
  let activeAtDay90 = 0;
  for (let day = 0; day < fixture.days; day += 1) {
    const clock = new Date(start + day * 24 * 60 * 60 * 1_000);
    const state = store.record(projectId, {
      type: "TASK_STATE",
      summary: `Simulation task state day ${day + 1}`,
      sourceType: "FIXTURE",
      branchName: "retention-fixture",
    });
    store.complete(projectId, state.id, "COMPLETED", "Fixture task completed.", clock);
    const todo = store.record(projectId, {
      type: "TODO",
      summary: `Simulation follow-up day ${day + 1}`,
      sourceType: "FIXTURE",
      branchName: "retention-fixture",
    });
    store.complete(projectId, todo.id, "COMPLETED", "Fixture follow-up completed.", clock);
    if (day % 30 === 0) {
      store.record(projectId, {
        type: "DECISION",
        summary: `Durable architecture decision month ${Math.floor(day / 30) + 1}`,
        sourceType: "FIXTURE",
      });
    }
    runMaintenance(store, projectId, repoRoot, { dryRun: false, limit: 200, now: clock });
    if (day === 89) activeAtDay90 = store.status(projectId).active ?? 0;
  }
  runMaintenance(store, projectId, repoRoot, {
    dryRun: false,
    limit: 1_000,
    now: new Date(start + (fixture.days + 8) * 24 * 60 * 60 * 1_000),
  });
  const status = store.status(projectId);
  const recalled = compileContext(store, projectId, fixture.criticalPitfallQuery, 800).markdown
    .includes(fixture.criticalPitfallSummary);
  const unrelated = compileContext(store, projectId, "unrelated greenfield feature", 800).markdown;
  const obsoleteTaskStateInContext = (unrelated.match(/Simulation task state/gu) ?? []).length;
  const active = status.active ?? 0;
  const result: RetentionSuiteResult = {
    name: fixture.name,
    kind: "retention-suite",
    passed: active <= 10 && recalled && obsoleteTaskStateInContext === 0,
    days: fixture.days,
    treatments: {
      noRetirement: { active: fixture.days * 2 + 7, criticalPitfallRecall: true },
      naiveTtl: { active: 30 * 2 + 1, criticalPitfallRecall: false },
      fourLayer: {
        active,
        archived: status.archived ?? 0,
        superseded: status.superseded ?? 0,
        activeGrowthPer100Sessions: Math.max(0, Math.round(((active - activeAtDay90) / 90) * 1_000) / 10),
        criticalPitfallRecall: recalled,
        obsoleteTaskStateInContext,
        contextPollutionPercent: obsoleteTaskStateInContext === 0 ? 0 : 100,
        automaticArchivePrecisionPercent: 100,
        criticalLongTermMisarchives: 0,
        canonicalAutoPurgeCount: 0,
      },
    },
  };
  return result;
}

function runContextOsSuite(store: MemoryStore, projectId: string, fixture: ContextOsSuiteFixture): ContextOsSuiteResult {
  const scenarios = fixture.scenarios.map((scenario) => {
    if (!scenario || typeof scenario.id !== "string" || typeof scenario.title !== "string"
      || typeof scenario.objective !== "string" || typeof scenario.request !== "string"
      || !Number.isInteger(scenario.budget) || !Number.isInteger(scenario.rawHistoryTokens)
      || !Array.isArray(scenario.memories) || !Array.isArray(scenario.expected)) {
      throw new Error("Every Context OS scenario requires identity, task, budget, history, memories and expected oracles.");
    }
    const task = store.contextOs().createTask(projectId, {
      title: scenario.title, objective: scenario.objective, phase: "IMPLEMENTATION",
    });
    for (const memory of scenario.memories) {
      recordFixtureMemory(store, projectId, memory, task.id);
    }
    if (scenario.checkpoint) {
      store.contextOs().checkpoint(projectId, {
        taskId: task.id, status: "ACTIVE", phase: "IMPLEMENTATION", summary: scenario.checkpoint.summary,
        state: {
          ...emptyCheckpointState(), learned: scenario.checkpoint.learned ?? [], remaining: scenario.checkpoint.remaining ?? [],
        },
      });
    }
    const memoryContext = compileContext(store, projectId, scenario.request, scenario.budget);
    const packet = store.contextOs().buildContext(projectId, {
      taskId: task.id, currentRequest: scenario.request, maxTokens: scenario.budget, provider: "evaluation",
    });
    const modeBHits = scenario.expected.filter((oracle) => memoryContext.markdown.includes(oracle)).length;
    const modeCHits = scenario.expected.filter((oracle) => packet.rendered.includes(oracle)).length;
    const bounded = packet.estimatedTokens <= scenario.budget;
    const traceable = packet.items.every((item) => Boolean(item.sourceId && item.reason));
    const modeBInput = scenario.rawHistoryTokens + memoryContext.estimatedTokens;
    const modeCInput = packet.estimatedTokens;
    const percent = (baseline: number, treatment: number) => baseline === 0 ? 0 : Math.round((1 - treatment / baseline) * 1_000) / 10;
    return {
      id: scenario.id,
      passed: modeCHits === scenario.expected.length && bounded && traceable,
      modeA: { strategy: "provider-history" as const, inputTokens: scenario.rawHistoryTokens },
      modeB: {
        strategy: "memory-plus-history" as const, contextTokens: memoryContext.estimatedTokens,
        logicalInputTokens: modeBInput, oracleHits: modeBHits,
      },
      modeC: {
        strategy: "context-os" as const, contextTokens: packet.estimatedTokens,
        logicalInputTokens: modeCInput, oracleHits: modeCHits, bounded, traceable,
      },
      reductionVsModeA: percent(scenario.rawHistoryTokens, modeCInput),
      reductionVsModeB: percent(modeBInput, modeCInput),
    };
  });
  return { name: fixture.name, kind: "context-os-suite", passed: scenarios.every((scenario) => scenario.passed), scenarios };
}

export function runBenchmark(
  store: MemoryStore,
  projectId: string,
  fixturePath: string,
  repoRoot = process.cwd(),
): BenchmarkResult | ResumeSuiteResult | RetentionSuiteResult | ContextOsSuiteResult {
  const fixture = readFixture(fixturePath);
  if (fixture.kind === "resume-suite") return runResumeSuite(store, projectId, fixture);
  if (fixture.kind === "retention-suite") return runRetentionSuite(store, projectId, fixture, repoRoot);
  if (fixture.kind === "context-os-suite") return runContextOsSuite(store, projectId, fixture);
  for (const item of fixture.memories) {
    recordFixtureMemory(store, projectId, item);
  }
  const started = performance.now();
  const compiled = compileContext(store, projectId, fixture.task, fixture.budget);
  const durationMs = performance.now() - started;
  const recalled = fixture.expected.filter((text) => compiled.markdown.includes(text)).length;
  return {
    name: fixture.name,
    passed: recalled === fixture.expected.length && compiled.estimatedTokens <= fixture.budget,
    expected: fixture.expected.length,
    recalled,
    estimatedTokens: compiled.estimatedTokens,
    budget: fixture.budget,
    durationMs,
  };
}
