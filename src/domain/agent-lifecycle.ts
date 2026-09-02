import type { Checkpoint, ContextPacket, Task } from "./context-os.js";

export const AGENT_LIFECYCLE_EVENT_TYPES = [
  "SESSION_STARTED",
  "USER_PROMPT_SUBMITTED",
  "TOOL_STARTED",
  "TOOL_COMPLETED",
  "TOOL_FAILED",
  "TOOL_BATCH_COMPLETED",
  "TURN_COMPLETED",
  "TURN_FAILED",
  "BEFORE_COMPACTION",
  "AFTER_COMPACTION",
  "SESSION_ENDED",
] as const;

export type AgentLifecycleEventType = typeof AGENT_LIFECYCLE_EVENT_TYPES[number];

export interface AgentLifecycleEvent {
  id: string;
  provider: string;
  type: AgentLifecycleEventType;
  sessionRefHash: string;
  occurredAt: string;
  payload: Record<string, string | boolean>;
  currentRequest?: string;
  preferredTaskId?: string;
  contextBudget?: number;
}

export interface AgentLifecycleOutcome {
  accepted: boolean;
  task?: Task;
  contextPacket?: ContextPacket;
  checkpoint?: Checkpoint;
  observations: number;
  candidates: number;
  persisted: number;
}
