import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isSessionEndEvent, sessionAgentKind, type AgentSource, type EventEnvelope, type StoredRawEvent } from "../domain/event.js";
import { CaptureService } from "./capture-service.js";
import { inImmediateTransaction } from "./sqlite-transaction.js";

/** Normalizes Agent lifecycle envelopes while retaining a bounded replay buffer. */
export class RawEventService {
  readonly #database: DatabaseSync;
  readonly #capture: CaptureService;

  constructor(database: DatabaseSync, capture: CaptureService) {
    this.#database = database;
    this.#capture = capture;
  }

  ingest(event: EventEnvelope): boolean {
    return inImmediateTransaction(this.#database, () => {
      const result = this.#database.prepare(`
        INSERT OR IGNORE INTO raw_events(
          id, project_id, session_ref_hash, agent_kind, event_type,
          payload_redacted_json, payload_digest, occurred_at, expires_at, ingestion_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(event.id, event.projectId, event.sessionRefHash, event.agentKind, event.eventType,
        JSON.stringify(event.payload), event.payloadDigest, event.occurredAt, event.expiresAt, event.ingestionVersion);
      if (Number(result.changes) === 0) return false;
      const session = this.#capture.upsertSession(event.projectId, {
        agentKind: sessionAgentKind(event.agentKind),
        externalSessionRefHash: event.sessionRefHash,
        startedAt: event.occurredAt,
        captureStatus: isSessionEndEvent(event.eventType) ? "ENDED" : "OPEN",
      });
      this.#capture.recordEpisode(event.projectId, {
        id: `raw-episode-${event.id}`,
        sessionId: session.id,
        type: isSessionEndEvent(event.eventType) ? "AGENT_SESSION_END" : "TOOL_RESULT",
        occurredAt: event.occurredAt,
        sourceDigest: createHash("sha256").update(`${event.eventType}\0${event.payloadDigest}`).digest("hex"),
        summary: isSessionEndEvent(event.eventType) ? "Agent session ended" : `Agent event observed: ${event.eventType}`,
        retentionClass: "SHORT",
      });
      if (isSessionEndEvent(event.eventType)) {
        this.#capture.endSession(event.projectId, session.id, { endedAt: event.occurredAt });
      }
      return true;
    });
  }

  unprocessed(projectId: string, sessionRefHash: string): StoredRawEvent[] {
    const rows = this.#database.prepare(`
      SELECT * FROM raw_events
      WHERE project_id = ? AND session_ref_hash = ? AND processed_at IS NULL
      ORDER BY occurred_at ASC, id ASC
    `).all(projectId, sessionRefHash) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: String(row.id), schemaVersion: 1, projectId: String(row.project_id),
      sessionRefHash: String(row.session_ref_hash), agentKind: String(row.agent_kind) as AgentSource,
      eventType: String(row.event_type) as StoredRawEvent["eventType"],
      payload: JSON.parse(String(row.payload_redacted_json)) as Record<string, string | boolean>,
      payloadDigest: String(row.payload_digest), occurredAt: String(row.occurred_at),
      expiresAt: String(row.expires_at), ingestionVersion: 1,
      ...(row.processed_at ? { processedAt: String(row.processed_at) } : {}),
      ...(this.#database.prepare("SELECT 1 FROM episodes WHERE id = ?").get(`raw-episode-${String(row.id)}`)
        ? { episodeId: `raw-episode-${String(row.id)}` } : {}),
    }));
  }

  pendingEndedSessions(projectId: string): string[] {
    const rows = this.#database.prepare(`
      SELECT DISTINCT session_ref_hash FROM raw_events
      WHERE project_id = ? AND event_type IN ('AGENT_SESSION_END', 'CLAUDE_SESSION_END') AND processed_at IS NULL
      ORDER BY session_ref_hash
    `).all(projectId) as Array<{ session_ref_hash: string }>;
    return rows.map((row) => row.session_ref_hash);
  }

  markProcessed(projectId: string, eventId: string, processedAt: string): void {
    this.#database.prepare("UPDATE raw_events SET processed_at = coalesce(processed_at, ?) WHERE project_id = ? AND id = ?")
      .run(processedAt, projectId, eventId);
  }

  deleteExpired(projectId: string, now: string): number {
    return Number(this.#database.prepare("DELETE FROM raw_events WHERE project_id = ? AND expires_at <= ?")
      .run(projectId, now).changes);
  }
}
