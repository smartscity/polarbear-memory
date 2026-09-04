import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { discoverGitContext } from "../../platform/git.js";
import { planProject, updateProjectPolicy, writeProjectConfig } from "../../platform/project.js";
import { SqliteMemoryStore } from "../../storage/sqlite-store.js";
import { CLAUDE_SPOOL_FILE_LIMIT, ingestClaudeHook, replayProjectSpool } from "./hooks.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "polarbear-memory-hooks-"));
  temporaryDirectories.push(temporary);
  const root = join(temporary, "repo");
  assert.equal(spawnSync("git", ["init", "-q", root], { shell: false }).status, 0);
  const previous = process.env.POLARBEAR_MEMORY_DATA_DIR;
  process.env.POLARBEAR_MEMORY_DATA_DIR = join(temporary, "data");
  const git = discoverGitContext(root);
  const project = planProject(git);
  writeProjectConfig(project);
  return {
    temporary,
    root,
    project,
    restoreEnvironment: () => {
      if (previous === undefined) delete process.env.POLARBEAR_MEMORY_DATA_DIR;
      else process.env.POLARBEAR_MEMORY_DATA_DIR = previous;
    },
  };
}

function stopInput(root: string, session = "session-1") {
  return {
    session_id: session,
    transcript_path: "/must/not/be/read/transcript-secret.jsonl",
    cwd: root,
    permission_mode: "default",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: [
      "Decision: FAILED is a terminal state.",
      "Pitfall: Never persist token=super-secret-value.",
      "Task state: Recovery endpoint is implemented in `src/recovery.ts`.",
      "Next step: Add recovery authorization coverage.",
    ].join("\n"),
  };
}

function endInput(root: string, session = "session-1") {
  return {
    session_id: session,
    transcript_path: "/must/not/be/read/transcript-secret.jsonl",
    cwd: root,
    permission_mode: "default",
    hook_event_name: "SessionEnd",
    reason: "other",
  };
}

test("Stop plus SessionEnd creates a redacted, idempotent automatic handoff", () => {
  const { root, project, restoreEnvironment } = fixture();
  try {
    const first = ingestClaudeHook(stopInput(root), root);
    const duplicate = ingestClaudeHook(stopInput(root), root);
    assert.equal(first.accepted, true);
    assert.equal(first.finalized, 4);
    assert.equal(duplicate.accepted, false);

    const ended = ingestClaudeHook(endInput(root), root);
    assert.equal(ended.finalized, 0);

    const store = new SqliteMemoryStore(project.databasePath);
    try {
      assert.equal(store.status(project.id).active, 4);
      assert.equal(store.search(project.id, "FAILED terminal", 10)
        .some(({ memory }) => memory.summary === "FAILED is a terminal state."), true);
      assert.equal(store.search(project.id, "super-secret-value", 10).length, 0);
      assert.equal(store.search(project.id, "transcript-secret", 10).length, 0);
      assert.match(store.search(project.id, "redacted", 10)[0]?.memory.summary ?? "", /<redacted>/u);
    } finally {
      store.close();
    }
  } finally {
    restoreEnvironment();
  }
});

test("new automatic TASK_STATE supersedes the prior active state on the branch", () => {
  const { root, project, restoreEnvironment } = fixture();
  try {
    ingestClaudeHook({ ...stopInput(root, "session-a"), last_assistant_message: "Task state: Recovery step one is complete." }, root);
    ingestClaudeHook(endInput(root, "session-a"), root);
    ingestClaudeHook({ ...stopInput(root, "session-b"), last_assistant_message: "Task state: Recovery step two is complete." }, root);
    ingestClaudeHook(endInput(root, "session-b"), root);
    const store = new SqliteMemoryStore(project.databasePath);
    try {
      assert.equal(store.search(project.id, "Recovery step", 10)
        .some(({ memory }) => memory.summary.includes("step one")), false);
      assert.equal(store.search(project.id, "Recovery step", 10)
        .some(({ memory }) => memory.summary.includes("step two")), true);
      assert.equal(store.status(project.id).superseded, 1);
    } finally {
      store.close();
    }
  } finally {
    restoreEnvironment();
  }
});

test("database failure spools events and replay finalizes them later", () => {
  const { root, project, restoreEnvironment } = fixture();
  try {
    mkdirSync(project.databasePath);
    assert.equal(ingestClaudeHook({ ...stopInput(root), last_assistant_message: "Decision: Use local spool replay." }, root).spooled, true);
    assert.equal(ingestClaudeHook(endInput(root), root).spooled, true);
    assert.equal(readdirSync(join(project.dataDir, "spool")).filter((name) => name.endsWith(".json")).length, 2);

    rmSync(project.databasePath, { recursive: true, force: true });
    const replayed = replayProjectSpool(project);
    assert.equal(replayed.replayed, 2);
    assert.equal(replayed.failed, 0);
    assert.equal(replayed.finalized, 1);
    assert.equal(existsSync(join(project.dataDir, "spool")), true);
    assert.equal(readdirSync(join(project.dataDir, "spool")).filter((name) => name.endsWith(".json")).length, 0);
  } finally {
    restoreEnvironment();
  }
});

test("database failure stops growing the local spool at its hard limit", () => {
  const { root, project, restoreEnvironment } = fixture();
  try {
    const spool = join(project.dataDir, "spool");
    mkdirSync(spool, { recursive: true });
    for (let index = 0; index < CLAUDE_SPOOL_FILE_LIMIT; index += 1) {
      writeFileSync(join(spool, `${index.toString(16).padStart(64, "0")}.json`), "{}\n");
    }
    mkdirSync(project.databasePath);
    const result = ingestClaudeHook(stopInput(root, "spool-limit-session"), root);
    assert.equal(result.accepted, false);
    assert.equal(result.spooled, false);
    assert.equal(readdirSync(spool).filter((name) => name.endsWith(".json")).length, CLAUDE_SPOOL_FILE_LIMIT);
  } finally {
    restoreEnvironment();
  }
});

test("raw non-boundary hook events expire after thirty days even when SessionEnd never arrives", () => {
  const { root, project, restoreEnvironment } = fixture();
  try {
    const prompt = (session: string) => ({
      session_id: session, cwd: root, hook_event_name: "UserPromptSubmit", prompt: "Continue the current work.",
    });
    ingestClaudeHook(prompt("abandoned-session"), root, new Date("2026-01-01T00:00:00.000Z"));
    ingestClaudeHook(prompt("current-session"), root, new Date("2026-02-01T00:00:00.000Z"));
    const store = new SqliteMemoryStore(project.databasePath);
    try {
      const hash = (session: string) => createHash("sha256").update(session).digest("hex");
      assert.equal(store.unprocessedRawEvents(project.id, hash("abandoned-session")).length, 0);
      assert.equal(store.unprocessedRawEvents(project.id, hash("current-session")).length, 1);
    } finally {
      store.close();
    }
  } finally {
    restoreEnvironment();
  }
});

test("capture policy disables hooks and controls raw-event retention", () => {
  const { root, project, restoreEnvironment } = fixture();
  try {
    updateProjectPolicy(project.configPath, { captureMode: "off" });
    assert.deepEqual(ingestClaudeHook(stopInput(root, "off-session"), root), { accepted: false, spooled: false, finalized: 0 });
    updateProjectPolicy(project.configPath, { captureMode: "summary", rawEventRetentionDays: 1 });
    ingestClaudeHook(stopInput(root, "short-retention"), root, new Date("2026-01-01T00:00:00.000Z"));
    ingestClaudeHook(stopInput(root, "current-retention"), root, new Date("2026-01-03T00:00:00.000Z"));
    const store = new SqliteMemoryStore(project.databasePath);
    try {
      const hash = createHash("sha256").update("short-retention").digest("hex");
      assert.equal(store.unprocessedRawEvents(project.id, hash).length, 0);
    } finally {
      store.close();
    }
  } finally {
    restoreEnvironment();
  }
});

test("zero-day retention keeps Stop until SessionEnd finalization and then removes raw events", () => {
  const { root, project, restoreEnvironment } = fixture();
  try {
    updateProjectPolicy(project.configPath, { captureMode: "summary", rawEventRetentionDays: 0 });
    const stopped = ingestClaudeHook({
      ...stopInput(root, "ephemeral"), last_assistant_message: "Decision: Finalize before zero-day cleanup.",
    }, root, new Date("2026-01-01T00:00:00.000Z"));
    assert.equal(stopped.finalized, 1);
    const ended = ingestClaudeHook(endInput(root, "ephemeral"), root, new Date("2026-01-01T00:01:00.000Z"));
    assert.equal(ended.finalized, 0);
    const store = new SqliteMemoryStore(project.databasePath);
    try {
      const hash = createHash("sha256").update("ephemeral").digest("hex");
      assert.equal(store.unprocessedRawEvents(project.id, hash).length, 0);
      assert.equal(store.search(project.id, "zero-day cleanup", 10).length, 1);
    } finally {
      store.close();
    }
  } finally {
    restoreEnvironment();
  }
});

test("UserPromptSubmit retrieves prompt-specific context without persisting the raw prompt", () => {
  const { root, project, restoreEnvironment } = fixture();
  try {
    const store = new SqliteMemoryStore(project.databasePath);
    store.initializeProject(project);
    const task = store.contextOs().createTask(project.id, {
      title: "Runtime discovery", objective: "Continue Desktop runtime discovery.", phase: "IMPLEMENTATION",
    });
    store.record(project.id, {
      type: "DECISION", summary: "Runtime discovery uses launch.json", scopeKind: "TASK", scopeRef: task.id,
    });
    store.close();

    const rawPrompt = "Continue Desktop runtime discovery with private-marker-92741.";
    const submitted = ingestClaudeHook({
      session_id: "prompt-session", cwd: root, hook_event_name: "UserPromptSubmit", prompt: rawPrompt,
    }, root);
    assert.match(submitted.additionalContext ?? "", /Runtime discovery uses launch\.json/u);
    assert.match(submitted.additionalContext ?? "", /UNTRUSTED|untrusted/u);

    const verified = new SqliteMemoryStore(project.databasePath);
    try {
      const sessionHash = createHash("sha256").update("prompt-session").digest("hex");
      const persisted = JSON.stringify(verified.unprocessedRawEvents(project.id, sessionHash));
      assert.doesNotMatch(persisted, /private-marker-92741/u);
      assert.match(persisted, /promptDigest/u);
      const packet = verified.contextOs().currentContext(project.id);
      assert.ok(packet);
      const receipt = verified.contextOs().contextReceipt(project.id, packet.id);
      assert.equal(receipt.status, "DELIVERED");
      assert.equal(receipt.deliveryPoint, "CLAUDE_HOOK_ADDITIONAL_CONTEXT");
    } finally {
      verified.close();
    }
  } finally {
    restoreEnvironment();
  }
});

test("SessionStart loads durable task context and PreCompact persists a checkpoint boundary", () => {
  const { root, project, restoreEnvironment } = fixture();
  const previousTaskId = process.env.POLARBEAR_TASK_ID;
  try {
    const store = new SqliteMemoryStore(project.databasePath);
    store.initializeProject(project);
    const task = store.contextOs().createTask(project.id, {
      title: "Claude lifecycle", objective: "Continue from durable Claude task context.", phase: "IMPLEMENTATION",
    });
    store.record(project.id, {
      type: "CONSTRAINT", summary: "Never bypass the Memory Engine API", scopeKind: "TASK", scopeRef: task.id,
    });
    store.close();
    process.env.POLARBEAR_TASK_ID = task.id;

    const started = ingestClaudeHook({
      session_id: "context-session", cwd: root, hook_event_name: "SessionStart", source: "startup",
    }, root);
    assert.match(started.additionalContext ?? "", /Continue from durable Claude task context/u);
    assert.match(started.additionalContext ?? "", /Never bypass the Memory Engine API/u);

    ingestClaudeHook({
      session_id: "context-session", cwd: root, hook_event_name: "PreCompact", source: "auto",
    }, root);
    const verified = new SqliteMemoryStore(project.databasePath);
    try {
      const checkpoint = verified.contextOs().latestCheckpoint(project.id, task.id);
      assert.ok(checkpoint);
      assert.match(checkpoint.summary, /compaction boundary/iu);
      assert.deepEqual(checkpoint.state.remaining, [task.objective]);
    } finally {
      verified.close();
    }
  } finally {
    if (previousTaskId === undefined) delete process.env.POLARBEAR_TASK_ID;
    else process.env.POLARBEAR_TASK_ID = previousTaskId;
    restoreEnvironment();
  }
});

test("Claude lifecycle creates task affinity and checkpoints changed files without Memory commands", () => {
  const { root, project, restoreEnvironment } = fixture();
  try {
    const promptResult = ingestClaudeHook({
      session_id: "automatic-task-session", cwd: root, hook_event_name: "UserPromptSubmit",
      prompt: "Implement the automatic checkpoint path.",
    }, root);
    assert.match(promptResult.additionalContext ?? "", /Implement the automatic checkpoint path/u);
    ingestClaudeHook({
      session_id: "automatic-task-session", cwd: root, hook_event_name: "PostToolUse",
      tool_name: "Write", tool_use_id: "write-one",
      tool_input: { file_path: join(root, "src", "automatic-checkpoint.ts") },
      tool_response: { success: true },
    }, root);
    ingestClaudeHook({
      session_id: "automatic-task-session", cwd: root, hook_event_name: "Stop",
      last_assistant_message: "Next step: Run the integration suite.",
    }, root);

    const verified = new SqliteMemoryStore(project.databasePath);
    try {
      const [task] = verified.contextOs().listTasks(project.id);
      assert.ok(task);
      const checkpoint = verified.contextOs().latestCheckpoint(project.id, task.id);
      assert.ok(checkpoint);
      assert.deepEqual(checkpoint.state.filesChanged, ["src/automatic-checkpoint.ts"]);
      assert.deepEqual(checkpoint.state.remaining, ["Run the integration suite.", task.objective]);
    } finally {
      verified.close();
    }
  } finally {
    restoreEnvironment();
  }
});
