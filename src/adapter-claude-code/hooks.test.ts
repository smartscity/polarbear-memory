import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { discoverGitContext } from "../platform/git.js";
import { planProject, updateProjectPolicy, writeProjectConfig } from "../platform/project.js";
import { SqliteMemoryStore } from "../storage/sqlite-store.js";
import { ingestClaudeHook, replayProjectSpool } from "./hooks.js";

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
    assert.equal(duplicate.accepted, false);

    const rawStore = new SqliteMemoryStore(project.databasePath);
    try {
      const sessionHash = createHash("sha256").update("session-1").digest("hex");
      const rawJson = JSON.stringify(rawStore.unprocessedRawEvents(project.id, sessionHash));
      assert.doesNotMatch(rawJson, /super-secret-value|transcript-secret/u);
      assert.match(rawJson, /<redacted>/u);
    } finally {
      rawStore.close();
    }

    const ended = ingestClaudeHook(endInput(root), root);
    assert.equal(ended.finalized, 4);

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

test("raw hook events expire after seven days even when SessionEnd never arrives", () => {
  const { root, project, restoreEnvironment } = fixture();
  try {
    ingestClaudeHook(stopInput(root, "abandoned-session"), root, new Date("2026-01-01T00:00:00.000Z"));
    ingestClaudeHook(stopInput(root, "current-session"), root, new Date("2026-01-09T00:00:00.000Z"));
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
    ingestClaudeHook({ ...stopInput(root, "ephemeral"), last_assistant_message: "Decision: Finalize before zero-day cleanup." }, root, new Date("2026-01-01T00:00:00.000Z"));
    const ended = ingestClaudeHook(endInput(root, "ephemeral"), root, new Date("2026-01-01T00:01:00.000Z"));
    assert.equal(ended.finalized, 1);
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
