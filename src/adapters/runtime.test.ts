import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CodexCliRuntime } from "./codex/runtime.js";
import { ClaudeCodeCliRuntime } from "./claude-code/runtime.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function executable(name: string, body: string): { command: string; cwd: string; argsPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), `polarbear-${name}-runtime-`));
  temporaryDirectories.push(cwd);
  const command = join(cwd, name);
  const argsPath = join(cwd, "args.json");
  writeFileSync(command, `#!/usr/bin/env node\n${body}\n`, { encoding: "utf8", mode: 0o700 });
  chmodSync(command, 0o700);
  return { command, cwd, argsPath };
}

test("Codex runtime enforces sandbox mode and parses JSONL sessions and usage", async () => {
  const fixture = executable("fake-codex", `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv[2] === "--version") process.stdout.write("codex-test 1.0\\n");
else {
  writeFileSync(join(process.cwd(), "args.json"), JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex completed." } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 101, cached_input_tokens: 11, output_tokens: 21 } }));
}
`);
  const runtime = new CodexCliRuntime(fixture.command);
  assert.equal((await runtime.detect()).available, true);
  const result = await runtime.start({ prompt: "Review the project", cwd: fixture.cwd, model: "test-model" });
  assert.equal(result.session.id, "codex-session");
  assert.equal(result.finalResponse, "Codex completed.");
  assert.deepEqual(result.usage, { inputTokens: 101, cachedInputTokens: 11, outputTokens: 21 });
  const args = JSON.parse(readFileSync(fixture.argsPath, "utf8")) as string[];
  assert.deepEqual(args, ["exec", "--json", "--sandbox", "read-only", "--model", "test-model", "Review the project"]);
});

test("Claude Code runtime defaults to plan mode and explicitly enables requested edits", async () => {
  const fixture = executable("fake-claude", `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv[2] === "--version") process.stdout.write("claude-test 1.0\\n");
else {
  writeFileSync(join(process.cwd(), "args.json"), JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({ type: "result", session_id: "claude-session", result: "Claude completed.", usage: {
    input_tokens: 202, cache_read_input_tokens: 22, output_tokens: 32
  } }));
}
`);
  const runtime = new ClaudeCodeCliRuntime(fixture.command);
  assert.equal((await runtime.detect()).available, true);
  const readOnly = await runtime.start({ prompt: "Inspect the project", cwd: fixture.cwd });
  assert.equal(readOnly.session.id, "claude-session");
  assert.equal(readOnly.finalResponse, "Claude completed.");
  assert.deepEqual(readOnly.usage, { inputTokens: 202, cachedInputTokens: 22, outputTokens: 32 });
  assert.deepEqual(JSON.parse(readFileSync(fixture.argsPath, "utf8")), [
    "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan", "Inspect the project",
  ]);
  await runtime.resume({ id: "claude-session", provider: "claude-code" }, {
    prompt: "Implement the change", cwd: fixture.cwd, writable: true, model: "test-model",
  });
  assert.deepEqual(JSON.parse(readFileSync(fixture.argsPath, "utf8")), [
    "-p", "--resume", "claude-session", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits", "--model", "test-model", "Implement the change",
  ]);
});
