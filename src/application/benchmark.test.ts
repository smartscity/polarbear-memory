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
