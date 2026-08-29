import type { MemoryType, RecordMemoryInput } from "../domain/memory.js";
import { isStopEvent } from "../domain/event.js";
import type { FinalizationMemoryPort } from "./ports.js";
import { captureFileAnchors } from "../platform/anchors.js";

const LABELS: Array<{ type: MemoryType; pattern: RegExp }> = [
  { type: "DECISION", pattern: /^(?:decision|决策|决定)\s*[:：-]\s*(.+)$/iu },
  { type: "PITFALL", pattern: /^(?:pitfall|failure|failed approach|失败经验|踩坑|注意)\s*[:：-]\s*(.+)$/iu },
  { type: "TASK_STATE", pattern: /^(?:task state|current state|progress|进度|当前状态)\s*[:：-]\s*(.+)$/iu },
  { type: "TODO", pattern: /^(?:todo|next step|next|下一步|待办)\s*[:：-]\s*(.+)$/iu },
];

function cleanLine(line: string): string {
  return line.trim().replace(/^[-*+]\s+/u, "").replace(/^\d+[.)]\s+/u, "").trim();
}

function extractFiles(text: string): string[] {
  const matches = text.match(/`([^`\n]+\.[A-Za-z0-9]{1,12})`/gu) ?? [];
  return [...new Set(matches
    .map((match) => match.slice(1, -1))
    .filter((path) => !path.startsWith("/") && !path.split("/").includes(".."))
    .slice(0, 20))];
}

export function extractCandidates(message: string): RecordMemoryInput[] {
  const candidates: RecordMemoryInput[] = [];
  for (const rawLine of message.split(/\r?\n/u).slice(0, 500)) {
    const line = cleanLine(rawLine);
    for (const { type, pattern } of LABELS) {
      const match = pattern.exec(line);
      let summary = match?.[1]?.trim();
      if (!summary || summary.length > 2_048) continue;
      const completionMatch = (type === "TASK_STATE" || type === "TODO")
        ? /^\[(completed|cancelled|已完成|已取消)\]\s*(.+)$/iu.exec(summary)
        : null;
      const completionState = completionMatch?.[1]?.toLowerCase();
      if (completionMatch?.[2]) summary = completionMatch[2].trim();
      candidates.push({
        type,
        summary,
        content: summary,
        files: extractFiles(summary),
        sourceType: "HOOK",
        confidence: 800,
        importance: type === "TASK_STATE" || type === "TODO" ? 600 : 700,
        ...(completionState
          ? { completionState: completionState === "completed" || completionState === "已完成" ? "COMPLETED" : "CANCELLED" }
          : {}),
      });
      break;
    }
  }
  return candidates.slice(0, 20);
}

export function finalizeSessionEvents(
  store: FinalizationMemoryPort,
  projectId: string,
  sessionRefHash: string,
  gitContext: { branchName?: string | undefined; commitSha?: string | undefined; projectRoot?: string | undefined } = {},
): {
  events: number;
  candidates: number;
  recorded: number;
} {
  const events = store.unprocessedRawEvents(projectId, sessionRefHash);
  let candidates = 0;
  let recorded = 0;
  for (const event of events) {
    if (isStopEvent(event.eventType)) {
      const message = typeof event.payload.lastAssistantMessage === "string" ? event.payload.lastAssistantMessage : "";
      for (const candidate of extractCandidates(message)) {
        candidates += 1;
        store.record(projectId, {
          ...candidate,
          ...(gitContext.branchName ? { branchName: gitContext.branchName } : {}),
          ...(gitContext.commitSha ? { commitSha: gitContext.commitSha } : {}),
          ...(event.episodeId ? { episodeId: event.episodeId } : {}),
          ...(gitContext.projectRoot && candidate.files && candidate.files.length > 0
            ? { fileAnchors: captureFileAnchors(gitContext.projectRoot, candidate.files, gitContext.commitSha) }
            : {}),
        });
        recorded += 1;
      }
    }
    store.markRawEventProcessed(projectId, event.id, new Date().toISOString());
  }
  store.deleteExpiredRawEvents(projectId, new Date().toISOString());
  return { events: events.length, candidates, recorded };
}
