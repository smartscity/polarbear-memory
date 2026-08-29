import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { finalizeSessionEvents } from "../../application/finalization.js";
import { runMaintenance } from "../../application/maintenance.js";
import type { EventEnvelope } from "../../domain/event.js";
import { discoverGitContext } from "../../platform/git.js";
import { loadProject, readProjectPolicy, type ProjectBinding, type ProjectPolicy } from "../../platform/project.js";
import { redactText } from "../../security/redaction.js";
import { SqliteMemoryStore } from "../../storage/sqlite-store.js";

export const CLAUDE_HOOK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "Stop", "SessionEnd",
] as const;

const HookInput = z.object({
  hook_event_name: z.enum(CLAUDE_HOOK_EVENTS),
  session_id: z.string().min(1).max(512),
  cwd: z.string().min(1).max(4_096),
  last_assistant_message: z.string().max(256 * 1024).optional(),
  stop_hook_active: z.boolean().optional(),
  reason: z.string().max(256).optional(),
  prompt: z.string().max(256 * 1024).optional(),
  tool_name: z.string().max(512).optional(),
  tool_input: z.unknown().optional(),
  tool_response: z.unknown().optional(),
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
    "AGENT_PRE_COMPACT", "AGENT_POST_COMPACT", "AGENT_STOP", "AGENT_SESSION_END",
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

function makeEnvelope(project: ProjectBinding, policy: ProjectPolicy, raw: z.infer<typeof HookInput>, now: Date): EventEnvelope {
  const eventTypes = {
    SessionStart: "AGENT_SESSION_START", UserPromptSubmit: "AGENT_USER_PROMPT", PreToolUse: "AGENT_PRE_TOOL",
    PostToolUse: "AGENT_POST_TOOL", PreCompact: "AGENT_PRE_COMPACT", PostCompact: "AGENT_POST_COMPACT",
    Stop: "AGENT_STOP", SessionEnd: "AGENT_SESSION_END",
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
    ...(raw.tool_input !== undefined ? { toolInput: boundedJson(raw.tool_input) } : {}),
    ...(raw.tool_response !== undefined ? { toolResponse: boundedJson(raw.tool_response) } : {}),
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

function writeSpool(project: ProjectBinding, envelope: EventEnvelope): void {
  const directory = join(project.dataDir, "spool");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = spoolPath(project, envelope.id);
  if (existsSync(target)) return;
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
}

export interface HookIngestionResult {
  accepted: boolean;
  spooled: boolean;
  finalized: number;
  additionalContext?: string;
}

export function replaySpool(project: ProjectBinding, store: SqliteMemoryStore): {
  replayed: number;
  failed: number;
  endedSessions: string[];
} {
  const directory = join(project.dataDir, "spool");
  if (!existsSync(directory)) return { replayed: 0, failed: 0, endedSessions: [] };
  let replayed = 0;
  let failed = 0;
  const endedSessions = new Set<string>();
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      const envelope = EventEnvelopeSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      if (envelope.projectId !== project.id) throw new Error("Spool project mismatch.");
      store.ingestRawEvent(envelope);
      store.contextOs().recordObservation(project.id, {
        provider: "claude-code", eventType: envelope.eventType, payload: envelope.payload, artifactRefs: [],
        estimatedTokens: Math.ceil(Buffer.byteLength(JSON.stringify(envelope.payload), "utf8") / 4), importance: 400,
        occurredAt: envelope.occurredAt, sourceFingerprint: envelope.id,
      });
      if (envelope.eventType === "AGENT_SESSION_END" || envelope.eventType === "CLAUDE_SESSION_END") endedSessions.add(envelope.sessionRefHash);
      unlinkSync(path);
      replayed += 1;
    } catch {
      failed += 1;
    }
  }
  return { replayed, failed, endedSessions: [...endedSessions] };
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
    const replayed = replaySpool(project, store);
    for (const sessionRefHash of new Set([...replayed.endedSessions, ...store.pendingEndedSessions(project.id)])) {
      finalizeSessionEvents(store, project.id, sessionRefHash, {
        branchName: inputGit.branch,
        commitSha: inputGit.head,
        projectRoot: project.root,
      });
    }
    const accepted = store.ingestRawEvent(envelope);
    const taskId = process.env.POLARBEAR_TASK_ID;
    const task = taskId ? store.contextOs().getTask(project.id, taskId) : undefined;
    store.contextOs().recordObservation(project.id, {
      ...(task ? { taskId: task.id } : {}), provider: "claude-code", eventType: envelope.eventType,
      payload: envelope.payload, artifactRefs: [],
      estimatedTokens: Math.ceil(Buffer.byteLength(JSON.stringify(envelope.payload), "utf8") / 4),
      importance: envelope.eventType === "AGENT_PRE_COMPACT" || envelope.eventType === "AGENT_SESSION_END" ? 900 : 400,
      occurredAt: envelope.occurredAt, sourceFingerprint: envelope.id,
    });
    if (task && envelope.eventType === "AGENT_PRE_COMPACT") {
      store.contextOs().checkpoint(project.id, {
        taskId: task.id, status: task.status, phase: task.phase,
        summary: "Claude Code reached a provider compaction boundary.",
        state: {
          changed: [], learned: ["Claude Code reached a provider compaction boundary."], decisionsAdded: [],
          constraintsAdded: [], failedAttempts: [], filesChanged: [], verification: [], unresolved: [],
          remaining: [task.objective],
        }, idempotencyKey: envelope.id,
      });
    }
    let finalized = 0;
    if (envelope.eventType === "AGENT_SESSION_END") {
      store.contextOs().distill(project.id, 200);
      finalized = finalizeSessionEvents(store, project.id, envelope.sessionRefHash, {
        branchName: inputGit.branch,
        commitSha: inputGit.head,
        projectRoot: project.root,
      }).recorded;
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
    const additionalContext = task && envelope.eventType === "AGENT_SESSION_START"
      ? store.contextOs().buildContext(project.id, {
          taskId: task.id, currentRequest: "Start or resume the active task.", provider: "claude-code", maxTokens: 2_000,
        }).rendered
      : undefined;
    return { accepted, spooled: false, finalized, ...(additionalContext ? { additionalContext } : {}) };
  } catch (error) {
    try {
      writeSpool(project, envelope);
      return { accepted: false, spooled: true, finalized: 0 };
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
    let finalized = 0;
    for (const sessionRefHash of new Set([...result.endedSessions, ...store.pendingEndedSessions(project.id)])) {
      finalized += finalizeSessionEvents(store, project.id, sessionRefHash, {
        branchName: git.branch,
        commitSha: git.head,
        projectRoot: project.root,
      }).recorded;
    }
    try {
      runMaintenance(store, project.id, project.root, {
        dryRun: false,
        limit: 200,
        ...(git.head ? { head: git.head } : {}),
      });
    } catch {
      // Spool replay remains useful even if lifecycle assessment cannot run.
    }
    return { replayed: result.replayed, failed: result.failed, finalized };
  } finally {
    store.close();
  }
}
