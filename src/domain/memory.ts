import type { CompletionState, CorrectnessRisk, FileAnchor, LifecycleAssessment, MemoryRelation, UsageStats } from "./lifecycle.js";

export const MVP_MEMORY_TYPES = [
  "DECISION",
  "PITFALL",
  "TASK_STATE",
  "TODO",
] as const;

export type MemoryType = (typeof MVP_MEMORY_TYPES)[number];
export type LifecycleStatus = "ACTIVE" | "ARCHIVED" | "SUPERSEDED" | "REJECTED";
export type VerificationState = "UNVERIFIED" | "VERIFIED" | "DISPUTED";

export interface Memory {
  id: string;
  projectId: string;
  type: MemoryType;
  summary: string;
  content: string;
  lifecycleStatus: LifecycleStatus;
  verificationState: VerificationState;
  correctnessRisk: CorrectnessRisk;
  relevance: number;
  completionState: CompletionState;
  confidence: number;
  importance: number;
  sourceType: "CLI" | "MCP" | "HOOK" | "FIXTURE";
  commitSha?: string;
  branchName?: string;
  files: string[];
  fileAnchors: FileAnchor[];
  relations: MemoryRelation[];
  usage: UsageStats;
  revisionCount: number;
  latestAssessment?: LifecycleAssessment;
  lastCheckedCommit?: string;
  lastAssessedAt?: string;
  completedAt?: string;
  restoreProtectedUntil?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecordMemoryInput {
  type: MemoryType;
  summary: string;
  content?: string;
  files?: string[];
  fileAnchors?: FileAnchor[];
  completionState?: CompletionState;
  sourceType?: "CLI" | "MCP" | "HOOK" | "FIXTURE";
  confidence?: number;
  importance?: number;
  commitSha?: string;
  branchName?: string;
}

export interface MemorySearchResult {
  memory: Memory;
  rank: number;
}

export function parseMemoryType(value: string): MemoryType {
  const normalized = value.toUpperCase();
  if (!MVP_MEMORY_TYPES.includes(normalized as MemoryType)) {
    throw new Error(`Unsupported memory type: ${value}. Expected ${MVP_MEMORY_TYPES.join(", ")}.`);
  }
  return normalized as MemoryType;
}

export function validateRecordInput(input: RecordMemoryInput): void {
  const summaryBytes = Buffer.byteLength(input.summary, "utf8");
  const contentBytes = Buffer.byteLength(input.content ?? input.summary, "utf8");
  if (input.summary.trim().length === 0) throw new Error("Summary must not be empty.");
  if (summaryBytes > 2 * 1024) throw new Error("Summary exceeds the 2 KiB limit.");
  if (contentBytes > 16 * 1024) throw new Error("Content exceeds the 16 KiB limit.");
  for (const value of [input.confidence ?? 700, input.importance ?? 500]) {
    if (!Number.isInteger(value) || value < 0 || value > 1000) {
      throw new Error("Confidence and importance must be integers between 0 and 1000.");
    }
  }
  if (input.completionState && input.completionState !== "OPEN"
    && input.type !== "TASK_STATE" && input.type !== "TODO") {
    throw new Error("Only TASK_STATE and TODO can be recorded as completed or cancelled.");
  }
}
