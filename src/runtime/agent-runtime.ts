export interface RuntimeCapabilities {
  persistentSessions: boolean;
  sessionResume: boolean;
  streamEvents: boolean;
  usageReporting: boolean;
  nativeMcp: boolean;
  lifecycleHooks: boolean;
  contextCompactionSignal: boolean;
}

export interface RuntimeSessionRef {
  id: string;
  provider: string;
}

export interface AgentExecutionInput {
  prompt: string;
  cwd: string;
  model?: string;
  writable?: boolean;
}

export interface RuntimeTurnResult {
  session: RuntimeSessionRef;
  finalResponse: string;
  events: Array<Record<string, unknown>>;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

export interface AgentRuntime {
  readonly provider: string;
  capabilities(): RuntimeCapabilities;
  detect(): Promise<{ available: boolean; version?: string }>;
  start(input: AgentExecutionInput): Promise<RuntimeTurnResult>;
  resume(session: RuntimeSessionRef, input: AgentExecutionInput): Promise<RuntimeTurnResult>;
}
