import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ContextOsMetrics, LifecycleMetricOutcome, LifecycleMetrics, Observation, UsageLedgerEntry,
} from "../domain/context-os.js";

interface ObservationRow {
  id: string; project_id: string; task_id: string | null; execution_run_id: string | null;
  agent_session_id: string | null; provider: string; event_type: string; payload_redacted_json: string;
  artifact_refs_json: string; estimated_tokens: number; importance_milli: number; occurred_at: string;
}

export class ContextTelemetryRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  recordObservation(projectId: string, input: Omit<Observation, "id" | "projectId"> & { sourceFingerprint?: string }): Observation {
    this.#assertReference(projectId, "tasks", input.taskId, "Task");
    this.#assertReference(projectId, "execution_runs", input.executionRunId, "Execution run");
    this.#assertReference(projectId, "agent_sessions", input.agentSessionId, "Agent session");
    const payload = JSON.stringify(input.payload);
    if (Buffer.byteLength(payload, "utf8") > 64 * 1024) throw new Error("Observation payload exceeds 64 KiB.");
    if (!Number.isInteger(input.importance) || input.importance < 0 || input.importance > 1_000) {
      throw new Error("Observation importance must be an integer between 0 and 1000.");
    }
    const fingerprint = input.sourceFingerprint ?? createHash("sha256")
      .update(`${input.provider}\0${input.eventType}\0${input.occurredAt}\0${payload}`).digest("hex");
    const existing = this.#database.prepare("SELECT * FROM observations WHERE project_id = ? AND source_fingerprint = ?")
      .get(projectId, fingerprint) as ObservationRow | undefined;
    if (existing) return this.#fromObservationRow(existing);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO observations(
        id, project_id, task_id, execution_run_id, agent_session_id, provider, event_type,
        payload_redacted_json, artifact_refs_json, estimated_tokens, importance_milli,
        source_fingerprint, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, projectId, input.taskId ?? null, input.executionRunId ?? null, input.agentSessionId ?? null,
      input.provider, input.eventType, payload, JSON.stringify(input.artifactRefs), input.estimatedTokens,
      input.importance, fingerprint, input.occurredAt, now,
    );
    return this.#fromObservationRow(this.#database.prepare("SELECT * FROM observations WHERE id = ?").get(id) as unknown as ObservationRow);
  }

  recordUsage(projectId: string, input: Omit<UsageLedgerEntry, "id" | "projectId" | "createdAt">): UsageLedgerEntry {
    this.#assertReference(projectId, "tasks", input.taskId, "Task");
    this.#assertReference(projectId, "execution_runs", input.executionRunId, "Execution run");
    for (const value of [input.inputTokens, input.cachedInputTokens, input.outputTokens, input.contextPacketTokens, input.usefulContextTokens]) {
      if (!Number.isInteger(value) || value < 0) throw new Error("Usage token counts must be non-negative integers.");
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO usage_ledger(
        id, project_id, task_id, execution_run_id, provider, input_tokens, cached_input_tokens,
        output_tokens, context_packet_tokens, useful_context_tokens, successful, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, projectId, input.taskId ?? null, input.executionRunId ?? null, input.provider,
      input.inputTokens, input.cachedInputTokens, input.outputTokens, input.contextPacketTokens,
      input.usefulContextTokens, input.successful ? 1 : 0, createdAt,
    );
    return { id, projectId, ...input, createdAt };
  }

  pendingObservations(projectId: string, limit: number, sessionRefHash?: string): Observation[] {
    const rows = (sessionRefHash
      ? this.#database.prepare(`
          SELECT * FROM observations
          WHERE project_id = ? AND persisted_as_memory = 0
            AND json_extract(payload_redacted_json, '$.sessionRefHash') = ?
          ORDER BY importance_milli DESC, occurred_at, id LIMIT ?
        `).all(projectId, sessionRefHash, limit)
      : this.#database.prepare(`
          SELECT * FROM observations WHERE project_id = ? AND persisted_as_memory = 0
          ORDER BY importance_milli DESC, occurred_at, id LIMIT ?
        `).all(projectId, limit)) as unknown as ObservationRow[];
    return rows.map((row) => this.#fromObservationRow(row));
  }

  markDistilled(projectId: string, observationIds: string[]): void {
    const update = this.#database.prepare("UPDATE observations SET persisted_as_memory = 1 WHERE project_id = ? AND id = ?");
    for (const id of observationIds) update.run(projectId, id);
  }

  recordLifecycleMetric(projectId: string, input: {
    provider: string; eventType: string; outcome: LifecycleMetricOutcome; latencyMs?: number;
  }): void {
    const latencyMs = input.latencyMs ?? 0;
    if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 600_000) throw new Error("Lifecycle latency must be between 0 and 600000 ms.");
    this.#database.prepare(`
      INSERT INTO lifecycle_counters(
        project_id, provider, event_type, outcome, event_count, total_latency_ms, max_latency_ms, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(project_id, provider, event_type, outcome) DO UPDATE SET
        event_count = event_count + 1,
        total_latency_ms = total_latency_ms + excluded.total_latency_ms,
        max_latency_ms = max(max_latency_ms, excluded.max_latency_ms),
        updated_at = excluded.updated_at
    `).run(projectId, input.provider, input.eventType, input.outcome, latencyMs, latencyMs, new Date().toISOString());
  }

  lifecycleMetrics(projectId: string): LifecycleMetrics {
    const observationRows = this.#database.prepare(`
      SELECT provider, event_type, count(*) AS count
      FROM observations WHERE project_id = ? GROUP BY provider, event_type ORDER BY provider, event_type
    `).all(projectId) as Array<{ provider: string; event_type: string; count: number }>;
    const eventsByProvider: Record<string, number> = {};
    const eventsByType: Record<string, number> = {};
    let eventsAccepted = 0;
    for (const row of observationRows) {
      eventsAccepted += row.count;
      eventsByProvider[row.provider] = (eventsByProvider[row.provider] ?? 0) + row.count;
      eventsByType[row.event_type] = (eventsByType[row.event_type] ?? 0) + row.count;
    }
    const counterRows = this.#database.prepare(`
      SELECT outcome, coalesce(sum(event_count), 0) AS count,
        coalesce(sum(total_latency_ms), 0) AS total_latency_ms,
        coalesce(max(max_latency_ms), 0) AS max_latency_ms
      FROM lifecycle_counters WHERE project_id = ? GROUP BY outcome
    `).all(projectId) as Array<{
      outcome: LifecycleMetricOutcome; count: number; total_latency_ms: number; max_latency_ms: number;
    }>;
    const counter = (outcome: LifecycleMetricOutcome) => counterRows.find((row) => row.outcome === outcome);
    const accepted = counter("ACCEPTED");
    const observations = this.#database.prepare(`
      SELECT count(*) AS total, coalesce(sum(CASE WHEN persisted_as_memory = 0 THEN 1 ELSE 0 END), 0) AS pending
      FROM observations WHERE project_id = ?
    `).get(projectId) as { total: number; pending: number };
    const retrieval = this.#database.prepare(`
      SELECT count(*) AS runs, coalesce(avg(latency_ms), 0) AS average_latency_ms
      FROM retrieval_runs WHERE project_id = ?
    `).get(projectId) as { runs: number; average_latency_ms: number };
    const p95Offset = retrieval.runs > 0 ? Math.ceil(retrieval.runs * 0.95) - 1 : 0;
    const p95 = retrieval.runs > 0
      ? (this.#database.prepare(`
          SELECT latency_ms FROM retrieval_runs WHERE project_id = ? ORDER BY latency_ms LIMIT 1 OFFSET ?
        `).get(projectId, p95Offset) as { latency_ms: number } | undefined)?.latency_ms ?? 0
      : 0;
    const packets = this.#database.prepare(`
      SELECT count(*) AS count, coalesce(sum(estimated_tokens), 0) AS tokens
      FROM context_packets WHERE project_id = ?
    `).get(projectId) as { count: number; tokens: number };
    const checkpoints = this.#database.prepare(`
      SELECT count(*) AS count,
        coalesce(sum(CASE WHEN summary LIKE 'Compaction checkpoint:%'
          OR summary LIKE 'Compaction boundary checkpoint%' THEN 1 ELSE 0 END), 0) AS compaction_count
      FROM checkpoints WHERE project_id = ?
    `).get(projectId) as { count: number; compaction_count: number };
    const hookMemories = this.#database.prepare(`
      SELECT count(*) AS count FROM memory_projection WHERE project_id = ? AND source_type = 'HOOK'
    `).get(projectId) as { count: number };
    return {
      eventsAccepted,
      eventsSpooled: counter("SPOOLED")?.count ?? 0,
      eventsReplayed: counter("REPLAYED")?.count ?? 0,
      failOpenOutcomes: counter("FAIL_OPEN")?.count ?? 0,
      eventsByProvider,
      eventsByType,
      observationsPending: observations.pending,
      observationsProcessed: observations.total - observations.pending,
      retrievalRuns: retrieval.runs,
      contextPacketsInjected: packets.count,
      injectedEstimatedTokens: packets.tokens,
      averageRetrievalLatencyMs: retrieval.average_latency_ms,
      p95RetrievalLatencyMs: p95,
      averageHookLatencyMs: accepted && accepted.count > 0 ? accepted.total_latency_ms / accepted.count : 0,
      maxHookLatencyMs: accepted?.max_latency_ms ?? 0,
      checkpointsCreated: checkpoints.count,
      compactionCheckpointsCreated: checkpoints.compaction_count,
      hookMemoriesPersisted: hookMemories.count,
    };
  }

  metrics(projectId: string, taskId?: string): ContextOsMetrics {
    const where = taskId ? "project_id = ? AND task_id = ?" : "project_id = ?";
    const args = taskId ? [projectId, taskId] : [projectId];
    const usage = this.#database.prepare(`
      SELECT count(*) AS runs, sum(successful) AS successful_runs,
        coalesce(sum(input_tokens), 0) AS input_tokens, coalesce(sum(cached_input_tokens), 0) AS cached_input_tokens,
        coalesce(sum(output_tokens), 0) AS output_tokens, coalesce(sum(context_packet_tokens), 0) AS packet_tokens,
        coalesce(sum(useful_context_tokens), 0) AS useful_tokens
      FROM usage_ledger WHERE ${where}
    `).get(...args) as {
      runs: number; successful_runs: number; input_tokens: number; cached_input_tokens: number;
      output_tokens: number; packet_tokens: number; useful_tokens: number;
    };
    const retrieval = this.#database.prepare(`
      SELECT coalesce(sum(candidate_tokens), 0) AS candidate_tokens,
        coalesce(sum(selected_tokens), 0) AS selected_tokens,
        coalesce(sum(candidate_count), 0) AS candidates, coalesce(sum(selected_count), 0) AS selected,
        coalesce(avg(latency_ms), 0) AS average_latency_ms
      FROM retrieval_runs WHERE ${where}
    `).get(...args) as {
      candidate_tokens: number; selected_tokens: number; candidates: number; selected: number; average_latency_ms: number;
    };
    const ratio = (numerator: number, denominator: number): number => denominator > 0 ? numerator / denominator : 0;
    return {
      runs: usage.runs, successfulRuns: usage.successful_runs, inputTokens: usage.input_tokens,
      cachedInputTokens: usage.cached_input_tokens, outputTokens: usage.output_tokens,
      contextPacketTokens: usage.packet_tokens,
      contextInjectionRatio: ratio(usage.packet_tokens, usage.input_tokens),
      contextReductionRatio: 1 - ratio(retrieval.selected_tokens, retrieval.candidate_tokens),
      contextReductionFactor: ratio(retrieval.candidate_tokens, retrieval.selected_tokens),
      memoryHitRate: ratio(usage.useful_tokens, usage.packet_tokens),
      contextWasteRatio: 1 - ratio(usage.useful_tokens, usage.packet_tokens),
      sessionCarryCostProxy: ratio(Math.max(0, usage.input_tokens - usage.packet_tokens), usage.packet_tokens),
      contextCostPerSuccessfulTask: ratio(usage.input_tokens, usage.successful_runs),
      averageAssemblyLatencyMs: usage.runs > 0 || retrieval.selected > 0 ? retrieval.average_latency_ms : 0,
    };
  }

  #fromObservationRow(row: ObservationRow): Observation {
    return {
      id: row.id, projectId: row.project_id, ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.execution_run_id ? { executionRunId: row.execution_run_id } : {}),
      ...(row.agent_session_id ? { agentSessionId: row.agent_session_id } : {}), provider: row.provider,
      eventType: row.event_type, payload: JSON.parse(row.payload_redacted_json) as Record<string, unknown>,
      artifactRefs: JSON.parse(row.artifact_refs_json) as string[], estimatedTokens: row.estimated_tokens,
      importance: row.importance_milli, occurredAt: row.occurred_at,
    };
  }

  #assertReference(projectId: string, table: "tasks" | "execution_runs" | "agent_sessions", id: string | undefined, label: string): void {
    if (id && !this.#database.prepare(`SELECT 1 FROM ${table} WHERE project_id = ? AND id = ?`).get(projectId, id)) {
      throw new Error(`${label} not found: ${id}`);
    }
  }
}
