import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMemoryType, validateRecordInput } from "./memory.js";

test("parses MVP memory types case-insensitively", () => {
  assert.equal(parseMemoryType("pitfall"), "PITFALL");
  assert.equal(parseMemoryType("fact"), "FACT");
  assert.equal(parseMemoryType("architecture"), "ARCHITECTURE");
  assert.throws(() => parseMemoryType("TRANSCRIPT"), /Unsupported memory type/);
});

test("enforces content and score limits", () => {
  assert.throws(() => validateRecordInput({ type: "TODO", summary: "" }), /must not be empty/);
  assert.throws(() => validateRecordInput({ type: "TODO", summary: "x", confidence: 1001 }), /between 0 and 1000/);
  assert.doesNotThrow(() => validateRecordInput({ type: "DECISION", summary: "Use SQLite" }));
});
