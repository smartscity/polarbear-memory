import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { captureFileAnchors } from "../platform/anchors.js";
import { SqliteMemoryStore } from "../storage/sqlite-store.js";
import { compileContext } from "./context.js";
import { runMaintenance } from "./maintenance.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "polarbear-retention-validation-"));
  temporaryDirectories.push(temporary);
  const root = join(temporary, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  git(temporary, ["init", "-q", root]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  git(root, ["config", "user.name", "Fixture"]);
  writeFileSync(join(root, "src", "policy.ts"), "export const retryLimit = 3;\n");
  writeFileSync(join(root, "src", "unrelated.ts"), "export const color = 'blue';\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  const projectId = "88888888-8888-4888-8888-888888888888";
  const store = new SqliteMemoryStore(join(temporary, "memory.db"));
  store.initializeProject({ id: projectId, name: "retention-validation" });
  return { root, projectId, store };
}

test("validation 7.1: stale correctness is independent from popularity and unrelated changes", () => {
  const { root, projectId, store } = fixture();
  try {
    const initialHead = git(root, ["rev-parse", "HEAD"]);
    const memory = store.record(projectId, {
      type: "DECISION",
      summary: "Recovery retries are bounded to three attempts",
      files: ["src/policy.ts"],
      fileAnchors: captureFileAnchors(root, ["src/policy.ts"], initialHead),
      commitSha: initialHead,
      sourceType: "FIXTURE",
      importance: 900,
    });
    runMaintenance(store, projectId, root, { dryRun: false, head: initialHead, now: new Date("2026-01-01T00:00:00Z") });
    for (let index = 0; index < 4; index += 1) {
      store.noteFeedback(projectId, memory.id, true, `Useful recovery evidence ${index}`);
    }

    writeFileSync(join(root, "src", "policy.ts"), "export const retryLimit = 9;\n");
    git(root, ["add", "src/policy.ts"]);
    git(root, ["commit", "-qm", "change retry semantics"]);
    const changedHead = git(root, ["rev-parse", "HEAD"]);
    runMaintenance(store, projectId, root, { dryRun: false, head: changedHead, now: new Date("2026-01-02T00:00:00Z") });

    const stale = store.get(projectId, memory.id);
    assert.equal(stale?.correctnessRisk, "HIGH");
    assert.ok(stale?.latestAssessment?.reasonCodes.includes("ANCHOR_DIGEST_CHANGED"));
    assert.equal(compileContext(store, projectId, "bounded recovery retries", 600).warningMemoryIds.includes(memory.id), true);

    store.verify(projectId, memory.id, "VERIFIED", "Rechecked the new retry policy.", "HUMAN_CLI", {
      anchors: captureFileAnchors(root, ["src/policy.ts"], changedHead),
      checkedCommit: changedHead,
    });
    writeFileSync(join(root, "src", "unrelated.ts"), "export const color = 'green';\n");
    git(root, ["add", "src/unrelated.ts"]);
    git(root, ["commit", "-qm", "unrelated UI change"]);
    const unrelatedHead = git(root, ["rev-parse", "HEAD"]);
    runMaintenance(store, projectId, root, { dryRun: false, head: unrelatedHead, now: new Date("2026-01-03T00:00:00Z") });
    assert.equal(store.get(projectId, memory.id)?.correctnessRisk, "LOW");
  } finally {
    store.close();
  }
});

test("validation 7.2: conflicts are preserved and confirmed supersession is idempotent and acyclic", () => {
  const { projectId, store } = fixture();
  try {
    const oldDecision = store.record(projectId, { type: "DECISION", summary: "Use legacy retry recovery policy", sourceType: "FIXTURE" });
    const newDecision = store.record(projectId, { type: "DECISION", summary: "Use bounded retry recovery policy", sourceType: "FIXTURE" });
    store.addRelation(projectId, newDecision.id, oldDecision.id, "CONTRADICTS", "Evidence is not yet conclusive.");
    assert.equal(store.get(projectId, oldDecision.id)?.lifecycleStatus, "ACTIVE");
    assert.equal(store.get(projectId, oldDecision.id)?.verificationState, "DISPUTED");
    assert.equal(store.get(projectId, newDecision.id)?.verificationState, "DISPUTED");

    store.verify(projectId, newDecision.id, "VERIFIED", "The bounded implementation and tests are current.");
    store.addRelation(projectId, newDecision.id, oldDecision.id, "SUPERSEDES", "The bounded policy is now authoritative.");
    const revisionCount = store.get(projectId, oldDecision.id)?.revisionCount;
    store.addRelation(projectId, newDecision.id, oldDecision.id, "SUPERSEDES", "The bounded policy is now authoritative.");
    assert.equal(store.get(projectId, oldDecision.id)?.revisionCount, revisionCount);
    assert.equal(store.get(projectId, oldDecision.id)?.lifecycleStatus, "SUPERSEDED");
    const context = compileContext(store, projectId, "retry recovery policy", 600);
    assert.equal(context.selectedMemoryIds.includes(newDecision.id), true);
    assert.equal(context.selectedMemoryIds.includes(oldDecision.id), false);
    assert.throws(
      () => store.addRelation(projectId, oldDecision.id, newDecision.id, "SUPERSEDES", "Attempt to create a cycle."),
      /cannot create a cycle/u,
    );
  } finally {
    store.close();
  }
});

test("validation 7.3 and type matrix: short-term state is bounded while old durable knowledge survives", () => {
  const { root, projectId, store } = fixture();
  try {
    let newestStateId = "";
    for (let index = 0; index < 20; index += 1) {
      newestStateId = store.record(projectId, {
        type: "TASK_STATE",
        summary: `Recovery task progress ${index}`,
        branchName: "main",
        sourceType: "FIXTURE",
      }).id;
    }
    assert.equal(store.list(projectId, { type: "TASK_STATE", status: "ACTIVE", limit: 100, offset: 0 }).length, 1);
    assert.equal(store.list(projectId, { type: "TASK_STATE", status: "ACTIVE", limit: 100, offset: 0 })[0]?.id, newestStateId);

    const todo = store.record(projectId, { type: "TODO", summary: "Remove completed migration flag", sourceType: "FIXTURE" });
    store.complete(projectId, todo.id, "COMPLETED", "Migration flag was removed.", new Date("2026-01-01T00:00:00Z"));
    assert.equal(compileContext(store, projectId, "completed migration flag", 500).selectedMemoryIds.includes(todo.id), false);

    const decision = store.record(projectId, { type: "DECISION", summary: "Keep the durable migration format", sourceType: "FIXTURE" });
    const pitfall = store.record(projectId, { type: "PITFALL", summary: "Rare migration deadlock requires bounded writer lock", sourceType: "FIXTURE" });
    runMaintenance(store, projectId, root, { dryRun: false, now: new Date("2026-07-01T00:00:00Z"), limit: 1000 });
    assert.equal(store.get(projectId, todo.id)?.lifecycleStatus, "ARCHIVED");
    assert.equal(store.get(projectId, decision.id)?.lifecycleStatus, "ACTIVE");
    assert.equal(store.get(projectId, pitfall.id)?.lifecycleStatus, "ACTIVE");
    assert.equal(compileContext(store, projectId, "rare migration deadlock writer lock", 500).selectedMemoryIds.includes(pitfall.id), true);

    const duplicate = store.record(projectId, { type: "PITFALL", summary: "Rare migration deadlock requires bounded writer lock", sourceType: "FIXTURE" });
    assert.equal(duplicate.id, pitfall.id);
  } finally {
    store.close();
  }
});

test("validation 7.4: maintenance is explainable and reversible without canonical purge", () => {
  const { root, projectId, store } = fixture();
  try {
    const head = git(root, ["rev-parse", "HEAD"]);
    const related = store.record(projectId, { type: "DECISION", summary: "Use local lifecycle audit", sourceType: "FIXTURE" });
    const todo = store.record(projectId, {
      type: "TODO",
      summary: "Finish lifecycle audit fixture",
      content: "Preserve this body, its anchor, relation and revisions.",
      files: ["src/policy.ts"],
      fileAnchors: captureFileAnchors(root, ["src/policy.ts"], head),
      sourceType: "FIXTURE",
    });
    store.addRelation(projectId, todo.id, related.id, "CONTRADICTS", "The fixture deliberately preserves a conflict.");
    store.complete(projectId, todo.id, "COMPLETED", "Fixture is complete.", new Date("2026-01-01T00:00:00Z"));
    const before = store.get(projectId, todo.id);
    assert.ok(before);

    const preview = runMaintenance(store, projectId, root, { dryRun: true, head, now: new Date("2026-01-09T00:00:00Z") });
    const previewAction = preview.actions.find((action) => action.memoryId === todo.id);
    assert.equal(previewAction?.newLifecycle, "ARCHIVED");
    assert.ok(previewAction?.reasonCodes.includes("SHORT_TERM_COMPLETED_7D"));
    const applied = runMaintenance(store, projectId, root, { dryRun: false, head, now: new Date("2026-01-09T00:00:00Z") });
    assert.deepEqual(applied.actions, preview.actions);
    const archived = store.get(projectId, todo.id);
    assert.equal(archived?.latestAssessment?.policyVersion, applied.policyVersion);
    assert.equal(archived?.latestAssessment?.assessorVersion, applied.assessorVersion);
    assert.ok(archived?.latestAssessment?.assessedAt);

    const restored = store.restore(projectId, todo.id, "Validate archive restoration fidelity.");
    assert.equal(restored.content, before.content);
    assert.deepEqual(restored.fileAnchors, before.fileAnchors);
    assert.deepEqual(restored.relations, before.relations);
    assert.equal(restored.revisionCount, (archived?.revisionCount ?? 0) + 1);
    assert.equal(runMaintenance(store, projectId, root, { dryRun: false, head, now: new Date("2026-01-10T00:00:00Z") }).changed, 0);
    assert.equal("purge" in store, false);
  } finally {
    store.close();
  }
});
