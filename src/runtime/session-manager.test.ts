import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentExecutionInput, AgentRuntime, RuntimeCapabilities, RuntimeSessionRef, RuntimeTurnResult } from "./agent-runtime.js";
import { RuntimeRouter } from "./runtime-router.js";
import { SessionManager } from "./session-manager.js";
import { SqliteMemoryStore } from "../storage/sqlite-store.js";
import { emptyCheckpointState } from "../domain/context-os.js";

const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class FakeRuntime implements AgentRuntime {
  readonly provider: string;
  starts = 0;
  resumes = 0;
  failResume = false;
  prompts: string[] = [];

  constructor(provider: string) {
    this.provider = provider;
  }

  capabilities(): RuntimeCapabilities {
    return {
      persistentSessions: true, sessionResume: true, streamEvents: true, usageReporting: true,
      nativeMcp: true, lifecycleHooks: false, contextCompactionSignal: false,
    };
  }

  async detect(): Promise<{ available: boolean; version?: string }> {
    return { available: true, version: `${this.provider}-test` };
  }

  async start(input: AgentExecutionInput): Promise<RuntimeTurnResult> {
    this.starts += 1;
    this.prompts.push(input.prompt);
    return this.#result(`${this.provider}-session-${this.starts}`);
  }

  async resume(session: RuntimeSessionRef, input: AgentExecutionInput): Promise<RuntimeTurnResult> {
    this.resumes += 1;
    this.prompts.push(input.prompt);
    if (this.failResume) throw new Error("provider session expired");
    return this.#result(session.id);
  }

  #result(sessionId: string): RuntimeTurnResult {
    return {
      session: { id: sessionId, provider: this.provider }, finalResponse: "Completed from durable context.",
      events: [{ type: "turn.completed" }], usage: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 30 },
    };
  }
}

function fixture() {
  const store = new SqliteMemoryStore(":memory:");
  store.initializeProject({ id: PROJECT_ID, name: "session-manager" });
  const task = store.contextOs().createTask(PROJECT_ID, {
    title: "Provider-neutral handoff", objective: "Continue the same task across providers.", phase: "IMPLEMENTATION",
  });
  return { store, task };
}

test("policy rotation persists a new durable boundary before starting a fresh session", async () => {
  const { store, task } = fixture();
  const runtime = new FakeRuntime("codex");
  const manager = new SessionManager(store.contextOs(), new RuntimeRouter().register(runtime));
  try {
    const original = store.contextOs().checkpoint(PROJECT_ID, {
      taskId: task.id, status: "ACTIVE", phase: "IMPLEMENTATION", summary: "Implementation is ready for review.",
      state: { ...emptyCheckpointState(), remaining: ["Perform independent review."] },
    });
    await manager.run({
      projectId: PROJECT_ID, taskId: task.id, provider: "codex", request: "Start review", cwd: process.cwd(),
      phase: "REVIEW", rotation: { implementationToReview: true },
    });
    const boundary = store.contextOs().latestCheckpoint(PROJECT_ID, task.id);
    assert.ok(boundary);
    assert.notEqual(boundary.id, original.id);
    assert.equal(boundary.previousCheckpointId, original.id);
    assert.match(boundary.summary, /before session rotation/u);
    assert.match(runtime.prompts[0] ?? "", /Perform independent review/u);
  } finally {
    store.close();
  }
});

test("resume failure records the failed attempt and recovers in a fresh provider session", async () => {
  const { store, task } = fixture();
  const runtime = new FakeRuntime("codex");
  runtime.failResume = true;
  const manager = new SessionManager(store.contextOs(), new RuntimeRouter().register(runtime));
  try {
    const result = await manager.run({
      projectId: PROJECT_ID, taskId: task.id, provider: "codex", request: "Continue implementation", cwd: process.cwd(),
      phase: "IMPLEMENTATION", resumeSessionId: "expired-session",
    });
    assert.equal(runtime.resumes, 1);
    assert.equal(runtime.starts, 1);
    assert.match(result.result.session.id, /codex-session/u);
    assert.equal(store.contextOs().metrics(PROJECT_ID, task.id).successfulRuns, 1);
  } finally {
    store.close();
  }
});

test("a checkpoint created after Codex is consumed by a fresh Claude Code session", async () => {
  const { store, task } = fixture();
  const codex = new FakeRuntime("codex");
  const claude = new FakeRuntime("claude-code");
  const manager = new SessionManager(store.contextOs(), new RuntimeRouter().register(codex).register(claude));
  try {
    await manager.run({
      projectId: PROJECT_ID, taskId: task.id, provider: "codex", request: "Investigate the runtime", cwd: process.cwd(),
      phase: "DEBUGGING",
    });
    store.contextOs().checkpoint(PROJECT_ID, {
      taskId: task.id, status: "ACTIVE", phase: "DEBUGGING", summary: "Codex identified the provider boundary.",
      state: { ...emptyCheckpointState(), learned: ["Session IDs remain provider opaque."], remaining: ["Implement the shared adapter."] },
    });
    await manager.run({
      projectId: PROJECT_ID, taskId: task.id, provider: "claude-code", request: "Continue in Claude Code", cwd: process.cwd(),
      phase: "IMPLEMENTATION", fresh: true,
    });
    assert.match(claude.prompts[0] ?? "", /Session IDs remain provider opaque/u);
    assert.match(claude.prompts[0] ?? "", /Implement the shared adapter/u);
  } finally {
    store.close();
  }
});

test("a checkpoint created after Claude Code is consumed by a fresh Codex session", async () => {
  const { store, task } = fixture();
  const codex = new FakeRuntime("codex");
  const claude = new FakeRuntime("claude-code");
  const manager = new SessionManager(store.contextOs(), new RuntimeRouter().register(codex).register(claude));
  try {
    await manager.run({
      projectId: PROJECT_ID, taskId: task.id, provider: "claude-code", request: "Design the shared runtime", cwd: process.cwd(),
      phase: "DESIGN",
    });
    store.contextOs().checkpoint(PROJECT_ID, {
      taskId: task.id, status: "ACTIVE", phase: "DESIGN", summary: "Claude designed the runtime boundary.",
      state: { ...emptyCheckpointState(), decisionsAdded: ["Core runtime contracts stay provider neutral."], remaining: ["Implement the Codex adapter."] },
    });
    await manager.run({
      projectId: PROJECT_ID, taskId: task.id, provider: "codex", request: "Continue in Codex", cwd: process.cwd(),
      phase: "IMPLEMENTATION", fresh: true,
    });
    assert.match(codex.prompts[0] ?? "", /Core runtime contracts stay provider neutral/u);
    assert.match(codex.prompts[0] ?? "", /Implement the Codex adapter/u);
  } finally {
    store.close();
  }
});
