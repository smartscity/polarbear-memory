export type RawEventType = "CLAUDE_STOP" | "CLAUDE_SESSION_END";

export interface EventEnvelope {
  id: string;
  schemaVersion: 1;
  projectId: string;
  sessionRefHash: string;
  agentKind: "claude-code";
  eventType: RawEventType;
  payload: Record<string, string | boolean>;
  payloadDigest: string;
  occurredAt: string;
  expiresAt: string;
  ingestionVersion: 1;
}

export interface StoredRawEvent extends EventEnvelope {
  processedAt?: string;
}
