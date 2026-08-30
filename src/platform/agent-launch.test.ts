import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  buildPolarbearLaunchSpec, minimalAgentEnvironment, resolveAgentRuntime, sanitizeAgentDiagnostic,
  probeMcpLaunch, serializeShellCommand,
} from "./agent-launch.js";

test("runtime resolution uses the current process and package-owned CLI artifact", () => {
  const runtime = resolveAgentRuntime();
  assert.equal(runtime.executable, process.execPath);
  assert.match(runtime.cliEntrypoint, /(?:^|[/\\])cli\.js$/u);
});

test("launch specs are structured and preserve arbitrary paths with spaces", () => {
  const spec = buildPolarbearLaunchSpec({
    executable: "/Arbitrary Runtime/Current/node",
    cliEntrypoint: "/Arbitrary Package/Polarbear/dist/cli.js",
  }, ["mcp", "--project-root", "/Work Trees/demo project"]);
  assert.deepEqual(spec, {
    command: "/Arbitrary Runtime/Current/node",
    args: ["/Arbitrary Package/Polarbear/dist/cli.js", "mcp", "--project-root", "/Work Trees/demo project"],
  });
  assert.doesNotMatch(spec.command, /polarbear-memory/u);
});

test("hook command serialization quotes POSIX and Windows paths without shell lookup", () => {
  const spec = {
    command: "/Runtime Path/node",
    args: ["/Package Path/cli.js", "hook", "value'with-quote"],
  };
  assert.equal(
    serializeShellCommand(spec, "darwin"),
    `'/Runtime Path/node' '/Package Path/cli.js' 'hook' 'value'"'"'with-quote'`,
  );
  assert.equal(
    serializeShellCommand({ command: "C:\\Runtime Path\\node.exe", args: ["C:\\Package Path\\cli.js", "hook"] }, "win32"),
    '"C:\\Runtime Path\\node.exe" "C:\\Package Path\\cli.js" "hook"',
  );
});

test("minimal Agent environment does not inherit an interactive PATH", () => {
  const posix = minimalAgentEnvironment(
    { PATH: "/interactive/runtime/bin", HOME: "/home/test" },
    "linux",
    "/interactive/runtime/bin/node",
  );
  assert.equal(posix.PATH, "/usr/bin:/bin");
  assert.equal(posix.HOME, "/home/test");

  const windows = minimalAgentEnvironment(
    { PATH: "C:\\Runtime\\bin;C:\\Git\\cmd", SystemRoot: "C:\\Windows" },
    "win32",
    "C:\\Runtime\\bin\\node.exe",
  );
  assert.equal(windows.PATH, "C:\\Git\\cmd");
  assert.equal(windows.SystemRoot, "C:\\Windows");
});

test("Agent diagnostics are bounded to inert single-line terminal text", () => {
  const noisy = `failed\n\u001b[31mred\u001b[0m\r${"x".repeat(2_000)}`;
  const sanitized = sanitizeAgentDiagnostic(noisy);
  assert.equal(sanitized.includes("\n"), false);
  assert.equal(sanitized.includes("\u001b"), false);
  assert.equal(sanitized.length, 1_024);
});

test("MCP probe keeps stdin open until initialize completes and waits for child cleanup", async () => {
  const fixture = [
    "process.stdin.resume();",
    "process.stdin.once('data', () => setTimeout(() => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{serverInfo:{name:'fixture',version:'1'}}}) + '\\n'), 25));",
    "process.stdin.once('end', () => process.exit(7));",
  ].join("");
  const result = await probeMcpLaunch(
    { command: process.execPath, args: ["-e", fixture] },
    { cwd: process.cwd(), timeoutMs: 1_000 },
  );
  assert.equal(result.kind, "SUCCESS", result.detail);
  assert.equal(result.ok, true);
  assert.ok(result.pid);
  assert.throws(() => process.kill(result.pid as number, 0));
});

test("MCP probe distinguishes spawn, exit, timeout, and protocol failures", async () => {
  const missing = await probeMcpLaunch(
    { command: join(tmpdir(), "missing-polarbear-runtime"), args: [] },
    { cwd: process.cwd(), timeoutMs: 100 },
  );
  assert.equal(missing.kind, "SPAWN_FAILURE");

  const earlyExit = await probeMcpLaunch(
    { command: process.execPath, args: ["-e", "process.exit(3)"] },
    { cwd: process.cwd(), timeoutMs: 1_000 },
  );
  assert.equal(earlyExit.kind, "EARLY_EXIT");

  const timeout = await probeMcpLaunch(
    { command: process.execPath, args: ["-e", "process.stdin.resume()"] },
    { cwd: process.cwd(), timeoutMs: 50 },
  );
  assert.equal(timeout.kind, "INITIALIZE_TIMEOUT");

  const protocol = await probeMcpLaunch(
    { command: process.execPath, args: ["-e", "process.stdin.once('data', () => process.stdout.write('not-json\\n')); process.stdin.resume()"] },
    { cwd: process.cwd(), timeoutMs: 1_000 },
  );
  assert.equal(protocol.kind, "PROTOCOL_ERROR");
  for (const result of [earlyExit, timeout, protocol]) {
    assert.ok(result.pid);
    assert.throws(() => process.kill(result.pid as number, 0));
  }
});
