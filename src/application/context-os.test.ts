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

test("automatic Context budgets scale with available task and Memory context", () => {
  const store = fixture();
  try {
    const small = store.contextOs().buildContext(PROJECT_ID, { currentRequest: "Explain this file." });
    const task = store.contextOs().createTask(PROJECT_ID, {
      title: "Review architecture",
      objective: "Review the complete Context OS architecture and its safety constraints.",
      phase: "REVIEW",
    });
    for (let index = 0; index < 20; index += 1) {
      store.record(PROJECT_ID, {
        type: index % 2 === 0 ? "DECISION" : "ARCHITECTURE",
        summary: `Architecture fact ${index}`,
        content: `Detailed reusable Context OS information ${index}. `.repeat(20),
        importance: 800,
      });
    }
    const large = store.contextOs().buildContext(PROJECT_ID, {
      taskId: task.id,
      currentRequest: "Compare every relevant decision, constraint, architecture boundary, and previous implementation result.",
    });
    assert.ok(small.maxTokens >= 500 && small.maxTokens <= 8_000);
    assert.ok(large.maxTokens > small.maxTokens);
    assert.equal(store.contextOs().currentContext(PROJECT_ID)?.id, large.id);
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

test("lifecycle metrics aggregate bounded counters, retrieval latency, distillation, and checkpoints", () => {
  const store = fixture();
  try {
    const task = store.contextOs().createTask(PROJECT_ID, {
      title: "Lifecycle telemetry", objective: "Measure lifecycle behavior.", phase: "VERIFICATION",
    });
    store.contextOs().recordObservation(PROJECT_ID, {
      taskId: task.id,
      provider: "codex-app-server",
      eventType: "TURN_COMPLETED",
      payload: { lastAssistantMessage: "Decision: Keep lifecycle counters local." },
      artifactRefs: [], estimatedTokens: 10, importance: 800,
      occurredAt: "2026-09-02T00:00:00.000Z", sourceFingerprint: "lifecycle-observation-1",
    });
    store.contextOs().recordLifecycleMetric(PROJECT_ID, {
      provider: "codex-app-server", eventType: "TURN_COMPLETED", outcome: "ACCEPTED", latencyMs: 12,
    });
    store.contextOs().recordLifecycleMetric(PROJECT_ID, {
      provider: "claude-code", eventType: "TURN_COMPLETED", outcome: "SPOOLED",
    });
    store.contextOs().recordLifecycleMetric(PROJECT_ID, {
      provider: "claude-code", eventType: "TURN_COMPLETED", outcome: "REPLAYED", latencyMs: 4,
    });
    store.contextOs().buildContext(PROJECT_ID, {
      taskId: task.id, currentRequest: "Inspect lifecycle telemetry.", provider: "codex-app-server", maxTokens: 600,
    });
    store.contextOs().checkpoint(PROJECT_ID, {
      taskId: task.id, status: "VERIFYING", phase: "VERIFICATION",
      summary: "Compaction boundary checkpoint with known telemetry state.",
      state: {
        changed: [], learned: [], decisionsAdded: [], constraintsAdded: [], failedAttempts: [], filesChanged: [],
        verification: [], unresolved: [], remaining: ["Verify telemetry."],
      },
    });
    assert.deepEqual(store.contextOs().distill(PROJECT_ID), { observations: 1, candidates: 1, recorded: 1 });

    const metrics = store.contextOs().lifecycleMetrics(PROJECT_ID);
    assert.equal(metrics.eventsAccepted, 1);
    assert.equal(metrics.eventsSpooled, 1);
    assert.equal(metrics.eventsReplayed, 1);
    assert.equal(metrics.eventsByProvider["codex-app-server"], 1);
    assert.equal(metrics.eventsByType.TURN_COMPLETED, 1);
    assert.equal(metrics.observationsPending, 0);
    assert.equal(metrics.observationsProcessed, 1);
    assert.equal(metrics.retrievalRuns, 1);
    assert.equal(metrics.contextPacketsInjected, 1);
    assert.ok(metrics.injectedEstimatedTokens > 0);
    assert.equal(metrics.averageHookLatencyMs, 12);
    assert.equal(metrics.maxHookLatencyMs, 12);
    assert.equal(metrics.checkpointsCreated, 1);
    assert.equal(metrics.compactionCheckpointsCreated, 1);
    assert.equal(metrics.hookMemoriesPersisted, 1);
  } finally {
    store.close();
  }
});
