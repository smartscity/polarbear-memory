import type {
  AgentExecutionInput, AgentRuntime, RuntimeCapabilities, RuntimeSessionRef, RuntimeTurnResult,
} from "../../runtime/agent-runtime.js";
import { parseJsonLines, runProcess } from "../../runtime/process-runner.js";

export class ClaudeCodeCliRuntime implements AgentRuntime {
  readonly provider = "claude-code";
  readonly #command: string;

  constructor(command = "claude") {
    this.#command = command;
  }

  capabilities(): RuntimeCapabilities {
    return {
      persistentSessions: true, sessionResume: true, streamEvents: true, usageReporting: true,
      nativeMcp: true, lifecycleHooks: true, contextCompactionSignal: true,
    };
  }

  async detect(): Promise<{ available: boolean; version?: string }> {
    try {
      const result = await runProcess(this.#command, ["--version"], process.cwd(), 64 * 1024);
      return result.exitCode === 0 ? { available: true, version: result.stdout.trim() || result.stderr.trim() } : { available: false };
    } catch {
      return { available: false };
    }
  }

  start(input: AgentExecutionInput): Promise<RuntimeTurnResult> {
    return this.#run([
      "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", input.writable ? "acceptEdits" : "plan",
      ...(input.model ? ["--model", input.model] : []), input.prompt,
    ], input);
  }

  resume(session: RuntimeSessionRef, input: AgentExecutionInput): Promise<RuntimeTurnResult> {
    if (session.provider !== this.provider) throw new Error("Cannot resume a session owned by another provider.");
    return this.#run([
      "-p", "--resume", session.id, "--output-format", "stream-json", "--verbose",
      "--permission-mode", input.writable ? "acceptEdits" : "plan",
      ...(input.model ? ["--model", input.model] : []), input.prompt,
    ], input, session.id);
  }

  async #run(args: string[], input: AgentExecutionInput, expectedSessionId?: string): Promise<RuntimeTurnResult> {
    const result = await runProcess(this.#command, args, input.cwd);
    const events = parseJsonLines(result.stdout);
    if (result.exitCode !== 0) throw new Error(`Claude Code runtime failed (${result.exitCode}): ${result.stderr.trim().slice(0, 4_096)}`);
    const terminal = [...events].reverse().find((event) => event.type === "result") ?? {};
    const usage = (terminal.usage ?? {}) as Record<string, number>;
    const sessionId = String(terminal.session_id ?? expectedSessionId ?? "");
    if (!sessionId) throw new Error("Claude Code did not report a session ID; the execution was not persisted as resumable.");
    return {
      session: { id: sessionId, provider: this.provider }, finalResponse: String(terminal.result ?? ""), events,
      usage: {
        inputTokens: Number(usage.input_tokens ?? 0), cachedInputTokens: Number(usage.cache_read_input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
      },
    };
  }
}
