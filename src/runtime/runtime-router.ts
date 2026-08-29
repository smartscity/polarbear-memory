import type { AgentRuntime } from "./agent-runtime.js";

export class RuntimeRouter {
  readonly #runtimes = new Map<string, AgentRuntime>();

  register(runtime: AgentRuntime): this {
    if (this.#runtimes.has(runtime.provider)) throw new Error(`Runtime is already registered: ${runtime.provider}`);
    this.#runtimes.set(runtime.provider, runtime);
    return this;
  }

  resolve(provider: string): AgentRuntime {
    const runtime = this.#runtimes.get(provider);
    if (!runtime) throw new Error(`Unsupported managed runtime: ${provider}`);
    return runtime;
  }

  list(): AgentRuntime[] {
    return [...this.#runtimes.values()];
  }
}
