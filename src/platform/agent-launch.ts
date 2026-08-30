import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
    assertAgentLaunchFile(spec.command, "Configured runtime executable", true);
    const cliEntrypoint = spec.args[0];
    if (!cliEntrypoint) throw new Error("Configured launch arguments do not contain a CLI entrypoint.");
    assertAgentLaunchFile(cliEntrypoint, "Configured Polarbear Memory CLI entrypoint", false);
    return { ok: true, kind: "SUCCESS", detail: "Runtime executable and CLI entrypoint are launchable." };
  } catch (error) {
    return { ok: false, kind: "VALIDATION_FAILURE", detail: error instanceof Error ? error.message : String(error) };
  }
}

export function assertAgentLaunchFile(path: string, label: string, executable: boolean): void {
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
  assertAgentLaunchFile(runtime.executable, "Current Node runtime", true);
  assertAgentLaunchFile(runtime.cliEntrypoint, "Polarbear Memory CLI entrypoint", false);
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

interface McpProbeOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function closesWithin(closePromise: Promise<void>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    void closePromise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

class McpLaunchProbeSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pid: number | undefined;
  private readonly closePromise: Promise<void>;
  private readonly timeoutMs: number;
  private finalizing = false;
  private stdout = "";
  private stderr = "";
  private initializeTimer?: NodeJS.Timeout;

  constructor(
    spec: AgentLaunchSpec,
    options: McpProbeOptions,
    private readonly resolve: (result: AgentLaunchProbe) => void,
  ) {
    this.child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: options.env ?? minimalAgentEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pid = this.child.pid;
    this.closePromise = new Promise((closeResolve) => this.child.once("close", () => closeResolve()));
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  start(): void {
    this.initializeTimer = setTimeout(() => this.finish({
      ok: false,
      kind: "INITIALIZE_TIMEOUT",
      detail: `MCP initialize timed out after ${this.timeoutMs} ms${this.stderr.trim() ? `: ${this.stderr.trim()}` : "."}`,
    }), this.timeoutMs);
    this.child.once("error", (error) => this.finish({
      ok: false,
      kind: "SPAWN_FAILURE",
      detail: `MCP spawn failed: ${error.message}`,
    }));
    this.child.once("exit", (code, signal) => {
      if (!this.finalizing) this.finish({
        ok: false,
        kind: "EARLY_EXIT",
        detail: `MCP process exited before initialize completed (code=${String(code)}, signal=${String(signal)})${this.stderr.trim() ? `: ${this.stderr.trim()}` : "."}`,
      });
    });
    this.child.stdin.on("error", (error) => {
      if (!this.finalizing) this.finish({
        ok: false,
        kind: "IO_FAILURE",
        detail: `MCP initialize request could not be written: ${error.message}`,
      });
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-4_096); });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    // EOF is an MCP client disconnect, so keep stdin open until initialize has answered.
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "polarbear-memory-doctor", version: "1" },
      },
    })}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdout += chunk;
    let newline = this.stdout.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdout.slice(0, newline).replace(/\r$/u, "");
      this.stdout = this.stdout.slice(newline + 1);
      if (line.trim() && !this.handleProtocolLine(line)) return;
      newline = this.stdout.indexOf("\n");
    }
    if (this.stdout.length > 256 * 1_024) {
      this.finish({ ok: false, kind: "PROTOCOL_ERROR", detail: "MCP stdout exceeded the protocol frame limit." });
    }
  }

  private handleProtocolLine(line: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.finish({ ok: false, kind: "PROTOCOL_ERROR", detail: "MCP stdout contained a non-JSON protocol line." });
      return false;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.finish({ ok: false, kind: "PROTOCOL_ERROR", detail: "MCP stdout contained a non-object protocol message." });
      return false;
    }
    const message = parsed as { id?: unknown; result?: { serverInfo?: unknown }; error?: { message?: unknown } };
    if (message.id !== 1) return true;
    if (!message.result?.serverInfo) {
      this.finish({
        ok: false,
        kind: "PROTOCOL_ERROR",
        detail: message.error
          ? `MCP initialize returned an error: ${String(message.error.message ?? "unknown error")}`
          : "MCP initialize response did not contain serverInfo.",
      });
      return false;
    }
    this.sendInitializedNotification();
    return false;
  }

  private sendInitializedNotification(): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`, (error) => {
      this.finish(error
        ? { ok: false, kind: "IO_FAILURE", detail: `MCP initialized notification could not be written: ${error.message}` }
        : { ok: true, kind: "SUCCESS", detail: "MCP initialize succeeded and diagnostic child cleanup completed." });
    });
  }

  private finish(result: AgentLaunchProbe): void {
    if (this.finalizing) return;
    this.finalizing = true;
    if (this.initializeTimer) clearTimeout(this.initializeTimer);
    void this.cleanup(result);
  }

  private async cleanup(result: AgentLaunchProbe): Promise<void> {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (this.pid === undefined) return this.resolve(result);
    if (await closesWithin(this.closePromise, 100)) return this.resolve({ ...result, pid: this.pid });
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    if (await closesWithin(this.closePromise, 250)) return this.resolve({ ...result, pid: this.pid });
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    if (await closesWithin(this.closePromise, 750)) return this.resolve({ ...result, pid: this.pid });
    this.resolve({
      ok: false,
      kind: "CLEANUP_FAILURE",
      detail: `MCP child cleanup failed after ${result.kind}: ${result.detail}`,
      pid: this.pid,
    });
  }
}

export function probeMcpLaunch(spec: AgentLaunchSpec, options: McpProbeOptions): Promise<AgentLaunchProbe> {
  return new Promise((resolve) => new McpLaunchProbeSession(spec, options, resolve).start());
}
