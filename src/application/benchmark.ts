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
  name: string;
  task: string;
  budget: number;
  memories: FixtureRecord[];
  expected: string[];
}

function readFixture(path: string): Fixture {
  const parsed: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("Fixture must be a JSON object.");
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

export function runBenchmark(store: MemoryStore, projectId: string, fixturePath: string): BenchmarkResult {
  const fixture = readFixture(fixturePath);
  for (const item of fixture.memories) {
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
