import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteMemoryStore } from "../storage/sqlite-store.js";
import { LifecycleOrchestrator } from "./lifecycle-orchestrator.js";

const PROJECT_ID = "12121212-1212-4212-8212-121212121212";

function fixture() {
  const store = new SqliteMemoryStore(":memory:");
  store.initializeProject({ id: PROJECT_ID, name: "lifecycle-affinity" });
  return store;
}

function event(id: string, type: "USER_PROMPT_SUBMITTED" | "TOOL_COMPLETED" | "TURN_COMPLETED" | "SESSION_ENDED", payload = {}) {
  return {
    id, provider: "claude-code", type, sessionRefHash: "session-affinity-one",
    occurredAt: `2026-09-05T00:00:0${id.length}.000Z`, payload,
  } as const;
}

test("lifecycle automatically creates task affinity and builds an idempotent continuation checkpoint", () => {
  const store = fixture();
  try {
    const orchestrator = new LifecycleOrchestrator(store.contextOs(), PROJECT_ID);
    const started = orchestrator.handle({
      ...event("prompt", "USER_PROMPT_SUBMITTED"),
      currentRequest: "Repair the runtime descriptor without persisting private prompt details.\nSecret follow-up detail.",
    });
    assert.equal(started.task?.title, "Repair the runtime descriptor without persisting private prompt details.");
    assert.equal(started.task?.objective, started.task?.title);
    assert.equal(started.contextPacket?.taskId, started.task?.id);

    orchestrator.handle(event("tool", "TOOL_COMPLETED", {
      toolName: "npm test", artifactRefs: JSON.stringify(["src/runtime-descriptor.ts"]),
    }));
    const completed = orchestrator.handle(event("turn", "TURN_COMPLETED", {
      lastAssistantMessage: [
        "Decision: Keep runtime discovery package-owned.",
        "Constraint: Desktop must use the Admin API.",
        "Next step: Verify the packaged installer.",
      ].join("\n"),
    }));
    assert.ok(completed.checkpoint);
    assert.equal(completed.checkpoint?.status, "ACTIVE");
    assert.deepEqual(completed.checkpoint?.state.filesChanged, ["src/runtime-descriptor.ts"]);
    assert.deepEqual(completed.checkpoint?.state.verification, [{ name: "npm test", status: "PASSED" }]);
    assert.deepEqual(completed.checkpoint?.state.decisionsAdded, ["Keep runtime discovery package-owned."]);
    assert.deepEqual(completed.checkpoint?.state.constraintsAdded, ["Desktop must use the Admin API."]);
    assert.deepEqual(completed.checkpoint?.state.remaining, ["Verify the packaged installer.", completed.task?.objective]);

    const ended = orchestrator.handle(event("ended", "SESSION_ENDED"));
    assert.equal(ended.task?.id, completed.task?.id);
    assert.equal(ended.checkpoint?.id, completed.checkpoint?.id);
  } finally {
    store.close();
  }
});

test("task affinity refuses an ambiguous silent attachment and uses a unique request match", () => {
  const store = fixture();
  try {
    const runtime = store.contextOs().createTask(PROJECT_ID, {
      title: "Runtime descriptor", objective: "Repair runtime descriptor installation.",
    });
    const retrieval = store.contextOs().createTask(PROJECT_ID, {
      title: "Retrieval ranking", objective: "Evaluate semantic retrieval ranking.",
    });
    const ambiguous = store.contextOs().resolveTaskAffinity(PROJECT_ID, {
      sessionRefHash: "new-session", currentRequest: "Continue the work.", createIfMissing: true,
    });
    assert.equal(ambiguous.reason, "AMBIGUOUS");
    assert.deepEqual(new Set(ambiguous.ambiguousTaskIds), new Set([runtime.id, retrieval.id]));

    const matched = store.contextOs().resolveTaskAffinity(PROJECT_ID, {
      sessionRefHash: "new-session", currentRequest: "Repair the runtime descriptor.", createIfMissing: true,
    });
    assert.equal(matched.reason, "REQUEST_MATCH");
    assert.equal(matched.task?.id, runtime.id);
    assert.throws(() => store.contextOs().resolveTaskAffinity(PROJECT_ID, {
      preferredTaskId: "missing-task", sessionRefHash: "new-session",
    }), /Preferred task not found/u);
  } finally {
    store.close();
  }
});

test("explicit completed task state closes the automatic Task and clears remaining work", () => {
  const store = fixture();
  try {
    const orchestrator = new LifecycleOrchestrator(store.contextOs(), PROJECT_ID);
    orchestrator.handle({
      ...event("done-prompt", "USER_PROMPT_SUBMITTED"), currentRequest: "Complete the migration verification.",
    });
    const completed = orchestrator.handle(event("done-turn", "TURN_COMPLETED", {
      lastAssistantMessage: "Task state: [completed] Migration verification passed.",
    }));
    assert.equal(completed.task?.id, completed.checkpoint?.taskId);
    assert.equal(completed.checkpoint?.status, "DONE");
    assert.deepEqual(completed.checkpoint?.state.remaining, []);
  } finally {
    store.close();
  }
});
