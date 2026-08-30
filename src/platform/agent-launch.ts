import { spawn } from "node:child_process";
import { constants, accessSync, existsSync, statSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";

export interface AgentRuntime {
  executable: string;
  cliEntrypoint: string;
}

export interface AgentLaunchSpec {
  command: string;
  args: string[];
}

export interface AgentLaunchProbe {
  ok: boolean;
  detail: string;
}

export function validateAgentLaunchSpec(spec: AgentLaunchSpec): AgentLaunchProbe {
  try {
    assertLaunchFile(spec.command, "Configured runtime executable", true);
    const cliEntrypoint = spec.args[0];
    if (!cliEntrypoint) throw new Error("Configured launch arguments do not contain a CLI entrypoint.");
    assertLaunchFile(cliEntrypoint, "Configured Polarbear Memory CLI entrypoint", false);
    return { ok: true, detail: "Runtime executable and CLI entrypoint are launchable." };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function assertLaunchFile(path: string, label: string, executable: boolean): void {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path: ${path}`);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} does not exist: ${path}`);
  if (executable) {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      throw new Error(`${label} is not executable: ${path}`);
    }
  }
}

export function resolveAgentRuntime(): AgentRuntime {
  // Resolve from the active package module so npm shims and process argv cannot redirect the generated launch.
  const runtime = {
    executable: process.execPath,
    cliEntrypoint: fileURLToPath(new URL("../cli.js", import.meta.url)),
  };
  assertLaunchFile(runtime.executable, "Current Node runtime", true);
  assertLaunchFile(runtime.cliEntrypoint, "Polarbear Memory CLI entrypoint", false);
  return runtime;
}

export function buildPolarbearLaunchSpec(runtime: AgentRuntime, args: string[]): AgentLaunchSpec {
  return { command: runtime.executable, args: [runtime.cliEntrypoint, ...args] };
}

function quotePosix(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("Agent launch arguments must not contain NUL or newline characters.");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteWindows(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("Agent launch arguments must not contain NUL or newline characters.");
  }
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
    } else if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      result += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return `${result}${"\\".repeat(backslashes * 2)}"`;
}

export function serializeShellCommand(spec: AgentLaunchSpec, platform: NodeJS.Platform = process.platform): string {
  const quote = platform === "win32" ? quoteWindows : quotePosix;
  return [spec.command, ...spec.args].map(quote).join(" ");
}

export function minimalAgentEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  runtimeExecutable = process.execPath,
): NodeJS.ProcessEnv {
  let path = "/usr/bin:/bin";
  if (platform === "win32") {
    // Keep system and Git tooling available while proving that the configured launch does not need this runtime on PATH.
    const runtimeDirectory = win32.resolve(win32.dirname(runtimeExecutable)).toLowerCase();
    path = (source.PATH ?? "").split(";")
      .filter((entry) => entry && win32.resolve(entry).toLowerCase() !== runtimeDirectory)
      .join(";");
  }
  const environment: NodeJS.ProcessEnv = { PATH: path };
  for (const name of [
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "TEMP", "TMP", "TMPDIR",
    "POLARBEAR_MEMORY_DATA_DIR",
  ]) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  return environment;
}

export function probeMcpLaunch(
  spec: AgentLaunchSpec,
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<AgentLaunchProbe> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: options.env ?? minimalAgentEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (result: AgentLaunchProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (!child.killed) child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: "MCP initialization timed out." }), options.timeoutMs ?? 5_000);
    child.once("error", (error) => finish({ ok: false, detail: error.message }));
    child.once("exit", (code, signal) => {
      if (!settled) finish({
        ok: false,
        detail: stderr.trim() || `MCP process exited before initialization (code=${String(code)}, signal=${String(signal)}).`,
      });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_096); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: { serverInfo?: unknown }; error?: { message?: unknown } };
          if (message.id !== 1) continue;
          if (message.result?.serverInfo) return finish({ ok: true, detail: "MCP initialization succeeded." });
          if (message.error) return finish({ ok: false, detail: String(message.error.message ?? "MCP initialization failed.") });
        } catch {
          // Wait for a complete newline-delimited MCP response.
        }
      }
      stdout = stdout.slice(-16_384);
    });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "polarbear-memory-doctor", version: "1" },
      },
    })}\n`);
  });
}
