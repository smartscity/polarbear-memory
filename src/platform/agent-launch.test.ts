import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPolarbearLaunchSpec, minimalAgentEnvironment, resolveAgentRuntime, serializeShellCommand,
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
  const environment = minimalAgentEnvironment({ PATH: "/interactive/runtime/bin", HOME: "/home/test" });
  assert.equal(environment.PATH, process.platform === "win32" ? "" : "/usr/bin:/bin");
  assert.equal(environment.HOME, "/home/test");

  const windows = minimalAgentEnvironment(
    { PATH: "C:\\Runtime\\bin;C:\\Git\\cmd", SystemRoot: "C:\\Windows" },
    "win32",
    "C:\\Runtime\\bin\\node.exe",
  );
  assert.equal(windows.PATH, "C:\\Git\\cmd");
  assert.equal(windows.SystemRoot, "C:\\Windows");
});
