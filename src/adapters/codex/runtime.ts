import type {
  AgentExecutionInput, AgentRuntime, RuntimeCapabilities, RuntimeSessionRef, RuntimeTurnResult,
} from "../../runtime/agent-runtime.js";
import { parseJsonLines, runProcess } from "../../runtime/process-runner.js";

export class CodexCliRuntime implements AgentRuntime {
  readonly provider = "codex";
  readonly #command: string;

  constructor(command = "codex") {
    this.#command = command;
  }

  capabilities(): RuntimeCapabilities {
    return {
      persistentSessions: true, sessionResume: true, streamEvents: true, usageReporting: true,
      nativeMcp: true, lifecycleHooks: false, contextCompactionSignal: false,
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
      "exec", "--json", "--sandbox", input.writable ? "workspace-write" : "read-only",
      ...(input.model ? ["--model", input.model] : []), input.prompt,
    ], input);
  }

  resume(session: RuntimeSessionRef, input: AgentExecutionInput): Promise<RuntimeTurnResult> {
    if (session.provider !== this.provider) throw new Error("Cannot resume a session owned by another provider.");
    return this.#run([
      "exec", "--json", "--sandbox", input.writable ? "workspace-write" : "read-only",
      ...(input.model ? ["--model", input.model] : []), "resume", session.id, input.prompt,
    ], input, session.id);
  }

  async #run(args: string[], input: AgentExecutionInput, expectedSessionId?: string): Promise<RuntimeTurnResult> {
    const result = await runProcess(this.#command, args, input.cwd);
    const events = parseJsonLines(result.stdout);
    if (result.exitCode !== 0) throw new Error(`Codex runtime failed (${result.exitCode}): ${result.stderr.trim().slice(0, 4_096)}`);
    const started = events.find((event) => event.type === "thread.started");
    const completed = [...events].reverse().find((event) => event.type === "turn.completed");
    const usage = (completed?.usage ?? {}) as Record<string, number>;
    const messages = events.filter((event) => event.type === "item.completed")
      .map((event) => event.item as Record<string, unknown> | undefined)
      .filter((item) => item?.type === "agent_message").map((item) => String(item?.text ?? ""));
    const sessionId = String(started?.thread_id ?? expectedSessionId ?? "");
    if (!sessionId) throw new Error("Codex did not report a thread ID; the execution was not persisted as resumable.");
    return {
      session: { id: sessionId, provider: this.provider }, finalResponse: messages.at(-1) ?? "", events,
      usage: {
        inputTokens: Number(usage.input_tokens ?? 0), cachedInputTokens: Number(usage.cached_input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
      },
    };
  }
}
