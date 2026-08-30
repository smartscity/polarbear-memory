import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPolarbearLaunchSpec, minimalAgentEnvironment, resolveAgentRuntime, sanitizeAgentDiagnostic,
  serializeShellCommand,
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
