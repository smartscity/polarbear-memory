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
  kind: "SUCCESS" | "VALIDATION_FAILURE" | "SPAWN_FAILURE" | "EARLY_EXIT" | "INITIALIZE_TIMEOUT" | "PROTOCOL_ERROR" | "IO_FAILURE" | "CLEANUP_FAILURE";
  detail: string;
  pid?: number;
}

export function sanitizeAgentDiagnostic(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 1_024);
}

export function validateAgentLaunchSpec(spec: AgentLaunchSpec): AgentLaunchProbe {
  try {
    assertLaunchFile(spec.command, "Configured runtime executable", true);
    const cliEntrypoint = spec.args[0];
    if (!cliEntrypoint) throw new Error("Configured launch arguments do not contain a CLI entrypoint.");
    assertLaunchFile(cliEntrypoint, "Configured Polarbear Memory CLI entrypoint", false);
    return { ok: true, kind: "SUCCESS", detail: "Runtime executable and CLI entrypoint are launchable." };
  } catch (error) {
    return { ok: false, kind: "VALIDATION_FAILURE", detail: error instanceof Error ? error.message : String(error) };
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
    const pid = child.pid;
    const closePromise = new Promise<void>((closeResolve) => child.once("close", () => closeResolve()));
    let finalizing = false;
    let stdout = "";
    let stderr = "";
    const closedWithin = (milliseconds: number): Promise<boolean> => new Promise((closedResolve) => {
      const cleanupTimer = setTimeout(() => closedResolve(false), milliseconds);
      void closePromise.then(() => {
        clearTimeout(cleanupTimer);
        closedResolve(true);
      });
    });
    const finish = async (result: AgentLaunchProbe): Promise<void> => {
      if (finalizing) return;
      finalizing = true;
      clearTimeout(initializeTimer);
      if (!child.stdin.destroyed) child.stdin.end();
      if (pid === undefined) {
        resolve(result);
        return;
      }
      if (await closedWithin(100)) {
        resolve({ ...result, pid });
        return;
      }
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (await closedWithin(250)) {
        resolve({ ...result, pid });
        return;
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (await closedWithin(750)) {
        resolve({ ...result, pid });
        return;
      }
      resolve({
        ok: false,
        kind: "CLEANUP_FAILURE",
        detail: `MCP child cleanup failed after ${result.kind}: ${result.detail}`,
        pid,
      });
    };
    const timeoutMs = options.timeoutMs ?? 5_000;
    const initializeTimer = setTimeout(() => void finish({
      ok: false,
      kind: "INITIALIZE_TIMEOUT",
      detail: `MCP initialize timed out after ${timeoutMs} ms${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
    }), timeoutMs);
    child.once("error", (error) => void finish({
      ok: false,
      kind: "SPAWN_FAILURE",
      detail: `MCP spawn failed: ${error.message}`,
    }));
    child.once("exit", (code, signal) => {
      if (!finalizing) void finish({
        ok: false,
        kind: "EARLY_EXIT",
        detail: `MCP process exited before initialize completed (code=${String(code)}, signal=${String(signal)})${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
      });
    });
    child.stdin.on("error", (error) => {
      if (!finalizing) void finish({
        ok: false,
        kind: "IO_FAILURE",
        detail: `MCP initialize request could not be written: ${error.message}`,
      });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_096); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      let newline = stdout.indexOf("\n");
      while (newline !== -1) {
        const line = stdout.slice(0, newline).replace(/\r$/u, "");
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) {
          newline = stdout.indexOf("\n");
          continue;
        }
        try {
          const message = JSON.parse(line) as { id?: unknown; result?: { serverInfo?: unknown }; error?: { message?: unknown } };
          if (message.id === 1) {
            if (message.result?.serverInfo) {
              child.stdin.write(`${JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
              })}\n`, (error) => {
                if (error) {
                  void finish({
                    ok: false,
                    kind: "IO_FAILURE",
                    detail: `MCP initialized notification could not be written: ${error.message}`,
                  });
                } else {
                  void finish({ ok: true, kind: "SUCCESS", detail: "MCP initialize succeeded and diagnostic child cleanup completed." });
                }
              });
            } else {
              void finish({
                ok: false,
                kind: "PROTOCOL_ERROR",
                detail: message.error
                  ? `MCP initialize returned an error: ${String(message.error.message ?? "unknown error")}`
                  : "MCP initialize response did not contain serverInfo.",
              });
            }
            return;
          }
        } catch {
          void finish({ ok: false, kind: "PROTOCOL_ERROR", detail: "MCP stdout contained a non-JSON protocol line." });
          return;
        }
        newline = stdout.indexOf("\n");
      }
      if (stdout.length > 256 * 1_024) {
        void finish({ ok: false, kind: "PROTOCOL_ERROR", detail: "MCP stdout exceeded the protocol frame limit." });
      }
    });
    // EOF is an MCP client disconnect, so keep stdin open until initialize has answered.
    child.stdin.write(`${JSON.stringify({
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
