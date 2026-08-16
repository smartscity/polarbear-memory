import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { SqliteMemoryStore } from "../storage/sqlite-store.js";
import { runBenchmark } from "./benchmark.js";

test("10-session resume suite produces valid packs and clears the file-read proxy gate", () => {
  const store = new SqliteMemoryStore(":memory:");
  const projectId = "55555555-5555-4555-8555-555555555555";
  store.initializeProject({ id: projectId, name: "resume-suite" });
  try {
    const result = runBenchmark(store, projectId, resolve("fixtures/resume-10/fixture.json"));
    assert.equal("kind" in result ? result.kind : undefined, "resume-suite");
    if (!("kind" in result) || result.kind !== "resume-suite") throw new Error("Expected resume suite result.");
    assert.equal(result.validPacks, 10);
    assert.equal(result.totalSessions, 10);
    assert.ok(result.medianFileReadReductionPercent >= 20);
    assert.equal(result.passed, true);
  } finally {
    store.close();
  }
});

test("180-day four-layer treatment bounds active growth without losing a rare pitfall", () => {
  const store = new SqliteMemoryStore(":memory:");
  const projectId = "66666666-6666-4666-8666-666666666666";
  store.initializeProject({ id: projectId, name: "retention-suite" });
  try {
    const result = runBenchmark(store, projectId, resolve("fixtures/retention-180d/fixture.json"));
    if (!("kind" in result) || result.kind !== "retention-suite") throw new Error("Expected retention suite result.");
    assert.equal(result.passed, true);
    assert.equal(result.treatments.naiveTtl.criticalPitfallRecall, false);
    assert.equal(result.treatments.fourLayer.criticalPitfallRecall, true);
    assert.ok(result.treatments.fourLayer.activeGrowthPer100Sessions <= 10);
    assert.equal(result.treatments.fourLayer.obsoleteTaskStateInContext, 0);
    assert.ok(result.treatments.fourLayer.automaticArchivePrecisionPercent >= 95);
    assert.equal(result.treatments.fourLayer.criticalLongTermMisarchives, 0);
    assert.equal(result.treatments.fourLayer.canonicalAutoPurgeCount, 0);
  } finally {
    store.close();
  }
});

test("malicious Memory fixture remains quoted untrusted data", () => {
  const store = new SqliteMemoryStore(":memory:");
  const projectId = "77777777-7777-4777-8777-777777777777";
  store.initializeProject({ id: projectId, name: "malicious-memory" });
  try {
    const result = runBenchmark(store, projectId, resolve("fixtures/security/malicious-memory.json"));
    assert.equal(result.passed, true);
  } finally {
    store.close();
  }
});
