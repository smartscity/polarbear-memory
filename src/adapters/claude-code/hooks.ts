import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { LifecycleOrchestrator } from "../../application/lifecycle-orchestrator.js";
import { acknowledgeSessionEvents } from "../../application/finalization.js";
import { runMaintenance } from "../../application/maintenance.js";
import type { AgentLifecycleEventType } from "../../domain/agent-lifecycle.js";
import type { EventEnvelope } from "../../domain/event.js";
import { discoverGitContext } from "../../platform/git.js";
import { loadProject, readProjectPolicy, type ProjectBinding, type ProjectPolicy } from "../../platform/project.js";
import { redactText } from "../../security/redaction.js";
import { SqliteMemoryStore } from "../../storage/sqlite-store.js";

export const CLAUDE_HOOK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch",
  "PreCompact", "PostCompact", "Stop", "StopFailure", "SessionEnd",
] as const;

export const CLAUDE_SPOOL_FILE_LIMIT = 512;

const HookInput = z.object({
  hook_event_name: z.enum(CLAUDE_HOOK_EVENTS),
  session_id: z.string().min(1).max(512),
  cwd: z.string().min(1).max(4_096),
  last_assistant_message: z.string().max(256 * 1024).optional(),
  stop_hook_active: z.boolean().optional(),
  reason: z.string().max(256).optional(),
  prompt: z.string().max(256 * 1024).optional(),
  tool_name: z.string().max(512).optional(),
  tool_use_id: z.string().max(512).optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
  error: z.unknown().optional(),
  tool_results: z.unknown().optional(),
  source: z.string().max(256).optional(),
}).passthrough();

export const EventEnvelopeSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaVersion: z.literal(1),
  projectId: z.uuid(),
  sessionRefHash: z.string().regex(/^[a-f0-9]{64}$/u),
  agentKind: z.literal("claude-code"),
  eventType: z.enum([
    "AGENT_SESSION_START", "AGENT_USER_PROMPT", "AGENT_PRE_TOOL", "AGENT_POST_TOOL",
    "AGENT_TOOL_FAILED", "AGENT_TOOL_BATCH", "AGENT_PRE_COMPACT", "AGENT_POST_COMPACT",
    "AGENT_STOP", "AGENT_TURN_FAILED", "AGENT_SESSION_END",
    "CLAUDE_STOP", "CLAUDE_SESSION_END",
  ]),
  payload: z.record(z.string(), z.union([z.string(), z.boolean()])),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  occurredAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  ingestionVersion: z.literal(1),
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedRetrievalPrompt(value: string, maxBytes = 16 * 1024): string {
  const redacted = redactText(value, homedir());
  if (Buffer.byteLength(redacted, "utf8") <= maxBytes) return redacted;
  let lower = 0;
  let upper = redacted.length;
  while (lower < upper) {
    const midpoint = Math.ceil((lower + upper) / 2);
    if (Buffer.byteLength(redacted.slice(0, midpoint), "utf8") <= maxBytes) lower = midpoint;
    else upper = midpoint - 1;
  }
  return redacted.slice(0, lower);
}

function makeEnvelope(project: ProjectBinding, policy: ProjectPolicy, raw: z.infer<typeof HookInput>, now: Date): EventEnvelope {
  const eventTypes = {
    SessionStart: "AGENT_SESSION_START", UserPromptSubmit: "AGENT_USER_PROMPT", PreToolUse: "AGENT_PRE_TOOL",
    PostToolUse: "AGENT_POST_TOOL", PostToolUseFailure: "AGENT_TOOL_FAILED", PostToolBatch: "AGENT_TOOL_BATCH",
    PreCompact: "AGENT_PRE_COMPACT", PostCompact: "AGENT_POST_COMPACT", Stop: "AGENT_STOP",
    StopFailure: "AGENT_TURN_FAILED", SessionEnd: "AGENT_SESSION_END",
  } as const;
  const eventType = eventTypes[raw.hook_event_name];
  const boundedJson = (value: unknown): string => redactText(JSON.stringify(value ?? {}).slice(0, 32 * 1024), homedir());
  const payload: Record<string, string | boolean> = {
    hookEventName: raw.hook_event_name,
    ...(raw.last_assistant_message ? { lastAssistantMessage: redactText(raw.last_assistant_message.slice(0, 32 * 1024), homedir()) } : {}),
    ...(raw.prompt ? {
      promptDigest: sha256(redactText(raw.prompt, homedir())),
      promptBytes: String(Buffer.byteLength(raw.prompt, "utf8")),
    } : {}),
    ...(raw.tool_name ? { toolName: raw.tool_name } : {}),
    ...(raw.tool_use_id ? { toolUseId: raw.tool_use_id } : {}),
    ...(raw.tool_input !== undefined ? { toolInput: boundedJson(raw.tool_input) } : {}),
    ...(raw.tool_response !== undefined ? { toolResponse: boundedJson(raw.tool_response) } : {}),
    ...(raw.error !== undefined ? { error: boundedJson(raw.error) } : {}),
    ...(raw.tool_results !== undefined ? { toolResults: boundedJson(raw.tool_results) } : {}),
    ...(raw.reason ? { reason: redactText(raw.reason, homedir()) } : {}),
    ...(raw.source ? { source: raw.source } : {}),
    ...(raw.hook_event_name === "Stop" ? { stopHookActive: raw.stop_hook_active ?? false } : {}),
  };
  const payloadJson = JSON.stringify(payload);
  const payloadDigest = sha256(payloadJson);
  const sessionRefHash = sha256(raw.session_id);
  return {
    id: sha256(`${project.id}\0${sessionRefHash}\0${eventType}\0${payloadDigest}`),
    schemaVersion: 1,
    projectId: project.id,
    sessionRefHash,
    agentKind: "claude-code",
    eventType,
    payload,
    payloadDigest,
    occurredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + policy.rawEventRetentionDays * 24 * 60 * 60 * 1_000).toISOString(),
    ingestionVersion: 1,
  };
}

function spoolPath(project: ProjectBinding, eventId: string): string {
  return join(project.dataDir, "spool", `${eventId}.json`);
}

function writeSpool(project: ProjectBinding, envelope: EventEnvelope): boolean {
  const directory = join(project.dataDir, "spool");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = spoolPath(project, envelope.id);
  if (existsSync(target)) return true;
  const queued = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name)).length;
  if (queued >= CLAUDE_SPOOL_FILE_LIMIT) return false;
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
  return true;
}

export interface HookIngestionResult {
  accepted: boolean;
  spooled: boolean;
  finalized: number;
  additionalContext?: string;
}

const NORMALIZED_EVENT_TYPES: Record<typeof CLAUDE_HOOK_EVENTS[number], AgentLifecycleEventType> = {
  SessionStart: "SESSION_STARTED",
  UserPromptSubmit: "USER_PROMPT_SUBMITTED",
  PreToolUse: "TOOL_STARTED",
  PostToolUse: "TOOL_COMPLETED",
  PostToolUseFailure: "TOOL_FAILED",
  PostToolBatch: "TOOL_BATCH_COMPLETED",
  PreCompact: "BEFORE_COMPACTION",
  PostCompact: "AFTER_COMPACTION",
  Stop: "TURN_COMPLETED",
  StopFailure: "TURN_FAILED",
  SessionEnd: "SESSION_ENDED",
};

function contextBudget(policy: ProjectPolicy): number | undefined {
  return policy.contextBudgetMode === "custom" ? policy.defaultContextBudget : undefined;
}

export function replaySpool(project: ProjectBinding, store: SqliteMemoryStore): {
  replayed: number;
  failed: number;
  finalized: number;
} {
  const directory = join(project.dataDir, "spool");
  if (!existsSync(directory)) return { replayed: 0, failed: 0, finalized: 0 };
  let replayed = 0;
  let failed = 0;
  let finalized = 0;
  const orchestrator = new LifecycleOrchestrator(store.contextOs(), project.id);
  const policy = readProjectPolicy(project.configPath);
  const budget = contextBudget(policy);
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      const envelope = EventEnvelopeSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      if (envelope.projectId !== project.id) throw new Error("Spool project mismatch.");
      store.ingestRawEvent(envelope);
      const outcome = orchestrator.handle({
        id: envelope.id,
        provider: "claude-code",
        type: normalizedEventType(envelope.eventType),
        sessionRefHash: envelope.sessionRefHash,
        occurredAt: envelope.occurredAt,
        payload: envelope.payload,
        ...(process.env.POLARBEAR_TASK_ID ? { preferredTaskId: process.env.POLARBEAR_TASK_ID } : {}),
        ...(budget === undefined ? {} : { contextBudget: budget }),
      });
      try {
        store.contextOs().recordLifecycleMetric(project.id, {
          provider: "claude-code", eventType: normalizedEventType(envelope.eventType), outcome: "SPOOLED",
        });
        store.contextOs().recordLifecycleMetric(project.id, {
          provider: "claude-code", eventType: normalizedEventType(envelope.eventType), outcome: "REPLAYED",
        });
      } catch {
        // Replay success must not depend on diagnostic counters.
      }
      finalized += outcome.persisted;
      if (isTurnBoundary(envelope.eventType)) acknowledgeSessionEvents(store, project.id, envelope.sessionRefHash);
      unlinkSync(path);
      replayed += 1;
    } catch {
      failed += 1;
    }
  }
  return { replayed, failed, finalized };
}

function normalizedEventType(eventType: EventEnvelope["eventType"]): AgentLifecycleEventType {
  const mapping: Record<EventEnvelope["eventType"], AgentLifecycleEventType> = {
    AGENT_SESSION_START: "SESSION_STARTED",
    AGENT_USER_PROMPT: "USER_PROMPT_SUBMITTED",
    AGENT_PRE_TOOL: "TOOL_STARTED",
    AGENT_POST_TOOL: "TOOL_COMPLETED",
    AGENT_TOOL_FAILED: "TOOL_FAILED",
    AGENT_TOOL_BATCH: "TOOL_BATCH_COMPLETED",
    AGENT_PRE_COMPACT: "BEFORE_COMPACTION",
    AGENT_POST_COMPACT: "AFTER_COMPACTION",
    AGENT_STOP: "TURN_COMPLETED",
    AGENT_TURN_FAILED: "TURN_FAILED",
    AGENT_SESSION_END: "SESSION_ENDED",
    CLAUDE_STOP: "TURN_COMPLETED",
    CLAUDE_SESSION_END: "SESSION_ENDED",
  };
  return mapping[eventType];
}

function isTurnBoundary(eventType: EventEnvelope["eventType"]): boolean {
  return eventType === "AGENT_STOP" || eventType === "AGENT_TURN_FAILED"
    || eventType === "AGENT_SESSION_END" || eventType === "CLAUDE_STOP" || eventType === "CLAUDE_SESSION_END";
}

export function ingestClaudeHook(rawInput: unknown, currentWorkingDirectory: string, now = new Date()): HookIngestionResult {
  const parsed = HookInput.parse(rawInput);
  const currentGit = discoverGitContext(currentWorkingDirectory);
  const inputGit = discoverGitContext(parsed.cwd);
  if (currentGit.root !== inputGit.root) throw new Error("Hook cwd does not match the bound project.");
  const project = loadProject(currentGit);
  const policy = readProjectPolicy(project.configPath);
  if (policy.captureMode === "off" || policy.captureMode === "manual") {
    return { accepted: false, spooled: false, finalized: 0 };
  }
  const envelope = makeEnvelope(project, policy, parsed, now);
  let store: SqliteMemoryStore | undefined;
  try {
    store = new SqliteMemoryStore(project.databasePath, { busyTimeoutMs: 100 });
    store.initializeProject(project);
    replaySpool(project, store);
    const accepted = store.ingestRawEvent(envelope);
    const budget = contextBudget(policy);
    const orchestrator = new LifecycleOrchestrator(store.contextOs(), project.id);
    const outcome = orchestrator.handle({
      id: envelope.id,
      provider: "claude-code",
      type: NORMALIZED_EVENT_TYPES[parsed.hook_event_name],
      sessionRefHash: envelope.sessionRefHash,
      occurredAt: envelope.occurredAt,
      payload: envelope.payload,
      ...(parsed.prompt ? { currentRequest: boundedRetrievalPrompt(parsed.prompt) } : {}),
      ...(process.env.POLARBEAR_TASK_ID ? { preferredTaskId: process.env.POLARBEAR_TASK_ID } : {}),
      ...(budget === undefined ? {} : { contextBudget: budget }),
    });
    if (isTurnBoundary(envelope.eventType)) acknowledgeSessionEvents(store, project.id, envelope.sessionRefHash);
    if (envelope.eventType === "AGENT_SESSION_END") {
      try {
        runMaintenance(store, project.id, project.root, {
          dryRun: false,
          limit: 50,
          ...(inputGit.head ? { head: inputGit.head } : {}),
        });
      } catch {
        // Lifecycle maintenance must not make a SessionEnd hook blocking or fatal.
      }
    }
    if (policy.rawEventRetentionDays > 0 || envelope.eventType === "AGENT_SESSION_END") {
      store.deleteExpiredRawEvents(project.id, now.toISOString());
    }
    const additionalContext = outcome.contextPacket?.rendered;
    if (additionalContext && outcome.contextPacket) {
      orchestrator.recordContextDelivery(outcome.contextPacket.id, {
        provider: "claude-code",
        integrationMode: "MANAGED",
        deliveryPoint: "CLAUDE_HOOK_ADDITIONAL_CONTEXT",
        status: "DELIVERED",
        sourceFingerprint: `claude-hook:${envelope.id}:${outcome.contextPacket.id}`,
      });
    }
    return {
      accepted,
      spooled: false,
      finalized: outcome.persisted,
      ...(additionalContext ? { additionalContext } : {}),
    };
  } catch (error) {
    try {
      return { accepted: false, spooled: writeSpool(project, envelope), finalized: 0 };
    } catch {
      throw error;
    }
  } finally {
    store?.close();
  }
}

export function replayProjectSpool(project: ProjectBinding): { replayed: number; failed: number; finalized: number } {
  const git = discoverGitContext(project.root);
  const store = new SqliteMemoryStore(project.databasePath);
  try {
    store.initializeProject(project);
    store.deleteExpiredRawEvents(project.id, new Date().toISOString());
    const result = replaySpool(project, store);
    try {
      runMaintenance(store, project.id, project.root, {
        dryRun: false,
        limit: 200,
        ...(git.head ? { head: git.head } : {}),
      });
    } catch {
      // Spool replay remains useful even if lifecycle assessment cannot run.
    }
    return result;
  } finally {
    store.close();
  }
}
