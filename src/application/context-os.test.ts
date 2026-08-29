import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteMemoryStore } from "../storage/sqlite-store.js";

const PROJECT_ID = "55555555-5555-4555-8555-555555555555";

function fixture(): SqliteMemoryStore {
  const store = new SqliteMemoryStore(":memory:");
  store.initializeProject({ id: PROJECT_ID, name: "context-os-fixture" });
  return store;
}

test("Task state and checkpoint survive independently of an agent session", () => {
  const store = fixture();
  try {
    const task = store.contextOs().createTask(PROJECT_ID, {
      title: "Implement recovery", objective: "Implement recovery without duplicating settlement.", phase: "IMPLEMENTATION",
    });
    const checkpoint = store.contextOs().checkpoint(PROJECT_ID, {
      taskId: task.id, status: "BLOCKED", phase: "DEBUGGING", summary: "Failure timing is understood.",
      state: {
        changed: [], learned: ["Failure arrives asynchronously."], decisionsAdded: [], constraintsAdded: [],
        failedAttempts: [{ approach: "Retry in callback", reason: "Failure is not observable yet." }],
        filesChanged: [], verification: [], unresolved: ["Retry count semantics"], remaining: ["Implement reconciliation retry"],
      }, idempotencyKey: "checkpoint-one",
    });
    const duplicate = store.contextOs().checkpoint(PROJECT_ID, {
      taskId: task.id, status: "BLOCKED", phase: "DEBUGGING", summary: "Failure timing is understood.",
      state: checkpoint.state, idempotencyKey: "checkpoint-one",
    });
    assert.equal(duplicate.id, checkpoint.id);
    assert.equal(store.contextOs().getTask(PROJECT_ID, task.id)?.lastCheckpointId, checkpoint.id);
  } finally {
    store.close();
  }
});

test("Context Planner keeps packets bounded and preserves inspectable provenance", () => {
  const store = fixture();
  try {
    const task = store.contextOs().createTask(PROJECT_ID, {
      title: "Review retry", objective: "Review retry invariants.", phase: "REVIEW",
    });
    store.record(PROJECT_ID, {
      type: "CONSTRAINT", summary: "Never duplicate settlement", content: "The idempotency key must be stable.",
      scopeKind: "TASK", scopeRef: task.id, importance: 1_000,
    });
    store.record(PROJECT_ID, {
      type: "DECISION", summary: "Retry from reconciliation", content: "Only reconciliation observes the final failure.",
      scopeKind: "TASK", scopeRef: task.id, importance: 1_000,
    });
    const packet = store.contextOs().buildContext(PROJECT_ID, {
      taskId: task.id, currentRequest: "Review the retry path", maxTokens: 400, provider: "codex",
    });
    assert.ok(packet.estimatedTokens <= 400);
    assert.ok(packet.items.some((item) => item.category === "CONSTRAINTS" || item.category === "DECISIONS"));
    const explanation = store.contextOs().explainContext(PROJECT_ID, packet.id);
    assert.equal(explanation.packet.id, packet.id);
    assert.ok(Object.keys(explanation.budgetByCategory).length > 0);
  } finally {
    store.close();
  }
});

test("Rotation policy is deterministic and requires a checkpoint boundary", () => {
  const store = fixture();
  try {
    assert.deepEqual(store.contextOs().decideRotation({ taskChanged: true }), {
      rotate: true, reason: "TASK_CHANGED", checkpointRequired: true,
    });
    assert.deepEqual(store.contextOs().decideRotation({ sessionTurnCount: 1, currentTaskAffinity: 1 }), {
      rotate: false, checkpointRequired: false,
    });
  } finally {
    store.close();
  }
});

test("Context Planner preserves mandatory P0 categories under hard budget pressure", () => {
  const store = fixture();
  try {
    const task = store.contextOs().createTask(PROJECT_ID, {
      title: "Budget pressure", objective: `Preserve this objective. ${"Detailed objective state. ".repeat(200)}`,
      phase: "IMPLEMENTATION",
    });
    store.contextOs().checkpoint(PROJECT_ID, {
      taskId: task.id, status: "ACTIVE", phase: "IMPLEMENTATION", summary: "Current checkpoint must survive.",
      state: {
        changed: [], learned: [], decisionsAdded: [], constraintsAdded: [], failedAttempts: [], filesChanged: [],
        verification: [], unresolved: [], remaining: ["Complete the budget-pressure verification."],
      },
    });
    store.record(PROJECT_ID, {
      type: "CONSTRAINT", summary: "Apache-2.0 compatibility is mandatory", scopeKind: "TASK", scopeRef: task.id,
    });
    store.record(PROJECT_ID, {
      type: "DECISION", summary: "Context packets remain immutable", scopeKind: "TASK", scopeRef: task.id,
    });
    const packet = store.contextOs().buildContext(PROJECT_ID, {
      taskId: task.id, currentRequest: "Continue under budget pressure", maxTokens: 400,
    });
    assert.ok(packet.estimatedTokens <= 400);
    assert.deepEqual(new Set(packet.items.filter((item) => item.priority === 0).map((item) => item.category)), new Set([
      "OBJECTIVE", "WORKING_MEMORY", "CONSTRAINTS", "DECISIONS",
    ]));
  } finally {
    store.close();
  }
});
