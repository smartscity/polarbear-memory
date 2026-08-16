import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { finalizeSessionEvents } from "../application/finalization.js";
import { runMaintenance } from "../application/maintenance.js";
import type { EventEnvelope } from "../domain/event.js";
import { discoverGitContext } from "../platform/git.js";
import { loadProject, type ProjectBinding } from "../platform/project.js";
import { redactText } from "../security/redaction.js";
import { SqliteMemoryStore } from "../storage/sqlite-store.js";

const HookInput = z.discriminatedUnion("hook_event_name", [
  z.object({
    hook_event_name: z.literal("Stop"),
    session_id: z.string().min(1).max(512),
    cwd: z.string().min(1).max(4_096),
    last_assistant_message: z.string().max(256 * 1024),
    stop_hook_active: z.boolean().optional(),
  }).passthrough(),
  z.object({
    hook_event_name: z.literal("SessionEnd"),
    session_id: z.string().min(1).max(512),
    cwd: z.string().min(1).max(4_096),
    reason: z.string().min(1).max(256),
  }).passthrough(),
]);

export const EventEnvelopeSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaVersion: z.literal(1),
  projectId: z.uuid(),
  sessionRefHash: z.string().regex(/^[a-f0-9]{64}$/u),
  agentKind: z.literal("claude-code"),
  eventType: z.enum(["CLAUDE_STOP", "CLAUDE_SESSION_END"]),
  payload: z.record(z.string(), z.union([z.string(), z.boolean()])),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  occurredAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  ingestionVersion: z.literal(1),
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeEnvelope(project: ProjectBinding, raw: z.infer<typeof HookInput>, now: Date): EventEnvelope {
  const eventType = raw.hook_event_name === "Stop" ? "CLAUDE_STOP" : "CLAUDE_SESSION_END";
  const payload: Record<string, string | boolean> = raw.hook_event_name === "Stop"
    ? {
        lastAssistantMessage: redactText(raw.last_assistant_message.slice(0, 32 * 1024), homedir()),
        stopHookActive: raw.stop_hook_active ?? false,
      }
    : { reason: redactText(raw.reason, homedir()) };
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
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
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
      if (envelope.eventType === "CLAUDE_SESSION_END") endedSessions.add(envelope.sessionRefHash);
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
  const envelope = makeEnvelope(project, parsed, now);
  let store: SqliteMemoryStore | undefined;
  try {
    store = new SqliteMemoryStore(project.databasePath, { busyTimeoutMs: 100 });
    store.initializeProject(project);
    store.deleteExpiredRawEvents(project.id, now.toISOString());
    const replayed = replaySpool(project, store);
    for (const sessionRefHash of new Set([...replayed.endedSessions, ...store.pendingEndedSessions(project.id)])) {
      finalizeSessionEvents(store, project.id, sessionRefHash, {
        branchName: inputGit.branch,
        commitSha: inputGit.head,
        projectRoot: project.root,
      });
    }
    const accepted = store.ingestRawEvent(envelope);
    let finalized = 0;
    if (envelope.eventType === "CLAUDE_SESSION_END") {
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
    return { accepted, spooled: false, finalized };
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
