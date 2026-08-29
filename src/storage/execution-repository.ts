import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentConnectionStatus, ExecutionRun, RotationReason, TaskPhase } from "../domain/context-os.js";
import { inImmediateTransaction } from "./sqlite-transaction.js";

interface RunRow {
  id: string; project_id: string; task_id: string | null; agent_session_id: string | null; provider: string;
  status: ExecutionRun["status"]; phase: TaskPhase; context_packet_id: string | null; checkpoint_id: string | null;
  rotation_reason: RotationReason | null; model: string | null; started_at: string; ended_at: string | null;
}

interface AgentSessionRow {
  provider: string;
  integration_mode: "ASSISTED" | "MANAGED";
  status: "OPEN" | "ENDED" | "FAILED";
  updated_at: string;
}

function fromRow(row: RunRow): ExecutionRun {
  return {
    id: row.id, projectId: row.project_id, ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.agent_session_id ? { agentSessionId: row.agent_session_id } : {}), provider: row.provider,
    status: row.status, phase: row.phase, ...(row.context_packet_id ? { contextPacketId: row.context_packet_id } : {}),
    ...(row.checkpoint_id ? { checkpointId: row.checkpoint_id } : {}),
    ...(row.rotation_reason ? { rotationReason: row.rotation_reason } : {}), ...(row.model ? { model: row.model } : {}),
    startedAt: row.started_at, ...(row.ended_at ? { endedAt: row.ended_at } : {}),
  };
}

export class ExecutionRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  start(projectId: string, input: {
    taskId?: string; provider: string; phase: TaskPhase; externalSessionRef?: string;
    integrationMode: "ASSISTED" | "MANAGED"; contextPacketId?: string; model?: string; rotationReason?: RotationReason;
  }): ExecutionRun {
    if (input.taskId && !this.#database.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get(projectId, input.taskId)) {
      throw new Error(`Task not found: ${input.taskId}`);
    }
    const id = randomUUID();
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const refHash = input.externalSessionRef
      ? createHash("sha256").update(input.externalSessionRef).digest("hex")
      : undefined;
    inImmediateTransaction(this.#database, () => {
      const existing = refHash ? this.#database.prepare(`
        SELECT id FROM agent_sessions WHERE project_id = ? AND provider = ? AND external_session_ref_hash = ?
      `).get(projectId, input.provider, refHash) as { id: string } | undefined : undefined;
      const resolvedSessionId = existing?.id ?? sessionId;
      if (!existing) {
        this.#database.prepare(`
          INSERT INTO agent_sessions(
            id, project_id, provider, integration_mode, external_session_ref_hash, status, started_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)
        `).run(sessionId, projectId, input.provider, input.integrationMode, refHash ?? null, now, now);
      }
      this.#database.prepare(`
        INSERT INTO execution_runs(
          id, project_id, task_id, agent_session_id, provider, status, phase, context_packet_id,
          rotation_reason, model, started_at
        ) VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?)
      `).run(
        id, projectId, input.taskId ?? null, resolvedSessionId, input.provider, input.phase,
        input.contextPacketId ?? null, input.rotationReason ?? null, input.model ?? null, now,
      );
    });
    return this.require(projectId, id);
  }

  finish(projectId: string, runId: string, input: {
    status: "SUCCEEDED" | "FAILED" | "CANCELLED"; externalSessionRef?: string;
  }): ExecutionRun {
    const current = this.require(projectId, runId);
    if (current.status !== "RUNNING") return current;
    const now = new Date().toISOString();
    const refHash = input.externalSessionRef
      ? createHash("sha256").update(input.externalSessionRef).digest("hex")
      : undefined;
    inImmediateTransaction(this.#database, () => {
      this.#database.prepare("UPDATE execution_runs SET status = ?, ended_at = ? WHERE project_id = ? AND id = ?")
        .run(input.status, now, projectId, runId);
      if (current.agentSessionId) {
        const existing = refHash ? this.#database.prepare(`
          SELECT id FROM agent_sessions
          WHERE project_id = ? AND provider = ? AND external_session_ref_hash = ? AND id <> ?
        `).get(projectId, current.provider, refHash, current.agentSessionId) as { id: string } | undefined : undefined;
        if (existing) {
          this.#database.prepare("UPDATE execution_runs SET agent_session_id = ? WHERE project_id = ? AND id = ?")
            .run(existing.id, projectId, runId);
          this.#database.prepare("DELETE FROM agent_sessions WHERE project_id = ? AND id = ?")
            .run(projectId, current.agentSessionId);
        }
        const sessionId = existing?.id ?? current.agentSessionId;
        this.#database.prepare(`
          UPDATE agent_sessions SET turn_count = turn_count + 1, updated_at = ?,
            external_session_ref_hash = coalesce(external_session_ref_hash, ?),
            status = CASE WHEN ? = 'SUCCEEDED' THEN 'OPEN' ELSE 'FAILED' END,
            ended_at = CASE WHEN ? = 'SUCCEEDED' THEN NULL ELSE ? END
          WHERE project_id = ? AND id = ?
        `).run(
          now, refHash ?? null, input.status, input.status, now, projectId, sessionId,
        );
      }
    });
    return this.require(projectId, runId);
  }

  listForTask(projectId: string, taskId: string, limit = 20): ExecutionRun[] {
    const rows = this.#database.prepare(`
      SELECT * FROM execution_runs WHERE project_id = ? AND task_id = ?
      ORDER BY started_at DESC, id DESC LIMIT ?
    `).all(projectId, taskId, limit) as unknown as RunRow[];
    return rows.map(fromRow);
  }

  agentConnections(projectId: string): AgentConnectionStatus[] {
    const sessions = this.#database.prepare(`
      SELECT provider, integration_mode, status, updated_at FROM agent_sessions
      WHERE project_id = ? ORDER BY updated_at DESC, id DESC
    `).all(projectId) as unknown as AgentSessionRow[];
    const activeRuns = this.#database.prepare(`
      SELECT provider, count(*) AS count FROM execution_runs
      WHERE project_id = ? AND status = 'RUNNING' GROUP BY provider
    `).all(projectId) as Array<{ provider: string; count: number }>;
    const activeByProvider = new Map(activeRuns.map(({ provider, count }) => [provider, Number(count)]));
    const seen = new Set<string>();
    return sessions.flatMap((session) => {
      if (seen.has(session.provider)) return [];
      seen.add(session.provider);
      const activeRunCount = activeByProvider.get(session.provider) ?? 0;
      return [{
        provider: session.provider,
        integrationMode: session.integration_mode,
        status: activeRunCount > 0 ? "ACTIVE" : session.status === "FAILED" ? "FAILED" : "IDLE",
        lastSeenAt: session.updated_at,
        activeRunCount,
      }];
    });
  }

  require(projectId: string, runId: string): ExecutionRun {
    const row = this.#database.prepare("SELECT * FROM execution_runs WHERE project_id = ? AND id = ?")
      .get(projectId, runId) as RunRow | undefined;
    if (!row) throw new Error(`Execution run not found: ${runId}`);
    return fromRow(row);
  }
}
