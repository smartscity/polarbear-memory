import type { AgentKind } from "./knowledge.js";

export type AgentSource = "claude-code" | "codex" | "cursor" | "other";
export type RawEventType =
  | "AGENT_SESSION_START" | "AGENT_USER_PROMPT" | "AGENT_PRE_TOOL" | "AGENT_POST_TOOL"
  | "AGENT_TOOL_FAILED" | "AGENT_TOOL_BATCH" | "AGENT_PRE_COMPACT" | "AGENT_POST_COMPACT"
  | "AGENT_STOP" | "AGENT_TURN_FAILED" | "AGENT_SESSION_END"
  | "CLAUDE_STOP" | "CLAUDE_SESSION_END";

export interface EventEnvelope {
  id: string;
  schemaVersion: 1;
  projectId: string;
  sessionRefHash: string;
  agentKind: AgentSource;
  eventType: RawEventType;
  payload: Record<string, string | boolean>;
  payloadDigest: string;
  occurredAt: string;
  expiresAt: string;
  ingestionVersion: 1;
}

export interface StoredRawEvent extends EventEnvelope {
  processedAt?: string;
  episodeId?: string;
}

export function isSessionEndEvent(eventType: RawEventType): boolean {
  return eventType === "AGENT_SESSION_END" || eventType === "CLAUDE_SESSION_END";
}

export function isStopEvent(eventType: RawEventType): boolean {
  return eventType === "AGENT_STOP" || eventType === "CLAUDE_STOP";
}

export function sessionAgentKind(source: AgentSource): AgentKind {
  if (source === "claude-code") return "CLAUDE";
  if (source === "codex") return "CODEX";
  if (source === "cursor") return "CURSOR";
  return "OTHER";
}
