import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileContext } from "./context.js";
import type { MemoryStore } from "./ports.js";
import { parseMemoryType, type RecordMemoryInput } from "../domain/memory.js";

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
}

interface ResumeSuiteFixture {
  kind: "resume-suite";
  name: string;
  sessions: ResumeSession[];
}

function readFixture(path: string): Fixture | ResumeSuiteFixture {
  const parsed: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("Fixture must be a JSON object.");
  if ((parsed as { kind?: unknown }).kind === "resume-suite") {
    const suite = parsed as Partial<ResumeSuiteFixture>;
    if (typeof suite.name !== "string" || !Array.isArray(suite.sessions) || suite.sessions.length !== 10) {
      throw new Error("Resume suite requires a name and exactly 10 sessions.");
    }
    return suite as ResumeSuiteFixture;
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
  sessions: Array<{
    id: string;
    passed: boolean;
    estimatedTokens: number;
    baselineFileReads: number;
    treatmentFileReads: number;
  }>;
}

function recordFixtureMemory(store: MemoryStore, projectId: string, item: FixtureRecord): void {
  if (!item || typeof item.summary !== "string" || typeof item.type !== "string") {
    throw new Error("Every fixture memory requires type and summary.");
  }
  const input: RecordMemoryInput = {
    type: parseMemoryType(item.type),
    summary: item.summary,
    sourceType: "FIXTURE",
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
    };
  });
  const reductions = sessions.map((session) => session.baselineFileReads === 0
    ? 0
    : ((session.baselineFileReads - session.treatmentFileReads) / session.baselineFileReads) * 100);
  const validPacks = sessions.filter((session) => session.passed).length;
  const reduction = Math.round(median(reductions) * 10) / 10;
  return {
    name: fixture.name,
    kind: "resume-suite",
    passed: validPacks === 10 && reduction >= 20,
    validPacks,
    totalSessions: sessions.length,
    medianFileReadReductionPercent: reduction,
    sessions,
  };
}

export function runBenchmark(store: MemoryStore, projectId: string, fixturePath: string): BenchmarkResult | ResumeSuiteResult {
  const fixture = readFixture(fixturePath);
  if (fixture.kind === "resume-suite") return runResumeSuite(store, projectId, fixture);
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
