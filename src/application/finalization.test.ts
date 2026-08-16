import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { extractCandidates } from "./finalization.js";

test("extracts only explicitly labeled reusable handoff lines", () => {
  const candidates = extractCandidates(`
Work completed successfully.
- Decision: Keep settlement retries outside the transaction.
- Pitfall: Timestamp ordering is ambiguous in batch ingestion.
- Task state: Recovery endpoint is implemented in \`src/recovery.ts\`.
- Next step: Add authorization coverage in \`test/recovery.test.ts\`.
I also looked around the repository.
`);
  assert.deepEqual(candidates.map((candidate) => candidate.type), ["DECISION", "PITFALL", "TASK_STATE", "TODO"]);
  assert.deepEqual(candidates[2]?.files, ["src/recovery.ts"]);
});

test("does not extract conversational filler or unsafe relative paths", () => {
  const candidates = extractCandidates("I am done.\nNext step: Inspect `../secret.env` and then continue.");
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]?.files, []);
});

test("accepts explicit completion markers without guessing task completion", () => {
  const [completed, open] = extractCandidates([
    "Task state: [completed] Recovery endpoint shipped.",
    "Next step: Authorization tests are being considered.",
  ].join("\n"));
  assert.equal(completed?.completionState, "COMPLETED");
  assert.equal(completed?.summary, "Recovery endpoint shipped.");
  assert.equal(open?.completionState, undefined);
});

test("10-session fixture clears the automatic handoff usefulness gate", () => {
  const fixture = JSON.parse(readFileSync(resolve("fixtures/automatic-handoff/fixture.json"), "utf8")) as {
    sessions: Array<{ lastAssistantMessage: string; expectedType: string; expectedSummary: string }>;
  };
  const useful = fixture.sessions.filter((session) => extractCandidates(session.lastAssistantMessage)
    .some((candidate) => candidate.type === session.expectedType && candidate.summary === session.expectedSummary));
  assert.equal(fixture.sessions.length, 10);
  assert.ok(useful.length / fixture.sessions.length >= 0.8);
  assert.equal(useful.length, 10);
});
