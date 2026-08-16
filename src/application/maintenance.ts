import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ASSESSOR_VERSION,
  POLICY_VERSION,
  type CorrectnessRisk,
  type MaintenanceAction,
  type MaintenancePlan,
} from "../domain/lifecycle.js";
import type { Memory } from "../domain/memory.js";
import { digestRepoFile } from "../platform/anchors.js";
import { changedFilesSince } from "../platform/git.js";
import type { MemoryStore } from "./ports.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function clamp(value: number): number {
  return Math.max(0, Math.min(1_000, Math.round(value)));
}

function relevance(memory: Memory): number {
  if (memory.completionState !== "OPEN") return 0;
  let score = memory.importance;
  if (memory.type === "PITFALL") score = Math.max(score, 650);
  if (memory.type === "DECISION") score = Math.max(score, 600);
  score += Math.min(memory.usage.selectedCount, 10) * 5;
  score += Math.min(memory.usage.positiveFeedbackCount, 4) * 50;
  score -= Math.min(memory.usage.negativeFeedbackCount, 4) * 50;
  if (memory.correctnessRisk === "MEDIUM") score -= 150;
  if (memory.correctnessRisk === "HIGH") score -= 400;
  return clamp(score);
}

function assessRisk(
  memory: Memory,
  repoRoot: string,
  changedFiles: Set<string> | undefined,
  firstScan: boolean,
): { risk: CorrectnessRisk; reasons: string[] } {
  if (memory.fileAnchors.length === 0) return { risk: memory.correctnessRisk, reasons: ["NO_FILE_ANCHOR"] };
  const touched = memory.fileAnchors.filter((anchor) => firstScan
    || memory.correctnessRisk === "HIGH"
    || changedFiles === undefined
    || changedFiles.has(anchor.path));
  if (touched.length === 0) return { risk: memory.correctnessRisk, reasons: ["SOURCE_PATH_UNCHANGED"] };
  let risk: CorrectnessRisk = "LOW";
  const reasons = new Set<string>();
  for (const anchor of touched) {
    const absolute = resolve(repoRoot, anchor.path);
    if (!existsSync(absolute)) {
      risk = "HIGH";
      reasons.add("ANCHOR_FILE_MISSING");
      continue;
    }
    const currentDigest = digestRepoFile(repoRoot, anchor.path);
    if (!currentDigest) {
      risk = "HIGH";
      reasons.add("ANCHOR_UNREADABLE_OR_TOO_LARGE");
    } else if (!anchor.contentDigest) {
      if (risk !== "HIGH") risk = "MEDIUM";
      reasons.add("ANCHOR_BASELINE_MISSING");
    } else if (currentDigest !== anchor.contentDigest) {
      risk = "HIGH";
      reasons.add("ANCHOR_DIGEST_CHANGED");
    } else {
      reasons.add("ANCHOR_DIGEST_MATCH");
    }
  }
  return { risk, reasons: [...reasons].sort() };
}

function shouldArchive(memory: Memory, now: Date): boolean {
  if ((memory.type !== "TASK_STATE" && memory.type !== "TODO") || memory.completionState === "OPEN" || !memory.completedAt) {
    return false;
  }
  const protectedUntil = memory.restoreProtectedUntil;
  if (protectedUntil && new Date(protectedUntil).getTime() > now.getTime()) return false;
  return now.getTime() - new Date(memory.completedAt).getTime() >= 7 * DAY_MS;
}

export interface MaintenanceOptions {
  dryRun: boolean;
  limit?: number;
  now?: Date;
  head?: string;
}

export function runMaintenance(
  store: MemoryStore,
  projectId: string,
  repoRoot: string,
  options: MaintenanceOptions,
): MaintenancePlan {
  const limit = options.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Maintenance limit must be 1–1000.");
  const now = options.now ?? new Date();
  const nowText = now.toISOString();
  const cursor = store.maintenanceCursor(projectId);
  const changedFiles = changedFilesSince(repoRoot, cursor, options.head);
  const archiveBefore = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const batch = store.maintenanceCandidates(
    projectId,
    limit + 1,
    changedFiles === undefined ? undefined : options.head,
    archiveBefore,
    nowText,
    changedFiles ? [...changedFiles] : [],
  );
  const hasMore = batch.length > limit;
  const memories = batch.slice(0, limit);
  const actions: MaintenanceAction[] = memories.map((memory) => {
    const assessed = assessRisk(memory, repoRoot, changedFiles, cursor === undefined);
    const archive = shouldArchive(memory, now);
    const nextLifecycle = archive ? "ARCHIVED" as const : memory.lifecycleStatus;
    const reasonCodes = [...assessed.reasons];
    if (archive) reasonCodes.push("SHORT_TERM_COMPLETED_7D");
    if (memory.type === "DECISION" || memory.type === "PITFALL") reasonCodes.push("LONG_TERM_AGE_PROTECTED");
    const action: MaintenanceAction = {
      memoryId: memory.id,
      previousRisk: memory.correctnessRisk,
      newRisk: assessed.risk,
      previousLifecycle: memory.lifecycleStatus,
      newLifecycle: nextLifecycle,
      relevance: relevance({ ...memory, correctnessRisk: assessed.risk }),
      reasonCodes: [...new Set(reasonCodes)].sort(),
      ...(options.head ? { checkedCommit: options.head } : {}),
    };
    return action;
  });
  const changed = actions.filter((action) => {
    const memory = memories.find((candidate) => candidate.id === action.memoryId);
    return memory && (action.newRisk !== action.previousRisk
      || action.newLifecycle !== action.previousLifecycle
      || action.relevance !== memory.relevance
      || action.checkedCommit !== memory.lastCheckedCommit);
  }).length;
  const expired = store.countExpiredRawEvents(projectId, nowText);
  let rawEventsDeleted = 0;
  if (!options.dryRun) {
    rawEventsDeleted = store.applyMaintenance(
      projectId,
      actions,
      hasMore ? cursor : options.head,
      nowText,
      POLICY_VERSION,
      ASSESSOR_VERSION,
    );
  }
  return {
    policyVersion: POLICY_VERSION,
    assessorVersion: ASSESSOR_VERSION,
    dryRun: options.dryRun,
    ...(options.head ? { checkedCommit: options.head } : {}),
    evaluated: memories.length,
    changed,
    rawEventsDeleted: options.dryRun ? expired : rawEventsDeleted,
    actions,
  };
}
