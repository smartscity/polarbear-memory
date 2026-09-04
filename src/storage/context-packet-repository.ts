import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ContextDeliveryMode, ContextExplanation, ContextPacket, ContextPacketItem, ContextReceipt,
} from "../domain/context-os.js";
import { inImmediateTransaction } from "./sqlite-transaction.js";

interface PacketRow {
  id: string; project_id: string; task_id: string | null; execution_run_id: string | null;
  retrieval_run_id: string; version: number; current_request: string; provider: string | null;
  max_tokens: number; estimated_tokens: number; packet_hash: string; rendered_text: string; created_at: string;
}

interface ItemRow {
  rank: number; source_type: ContextPacketItem["sourceType"]; source_id: string;
  category: ContextPacketItem["category"]; priority: 0 | 1 | 2 | 3; score_milli: number;
  estimated_tokens: number; reason: string; content: string; truncated: number;
}

interface DeliveryRow {
  packet_id: string;
  provider: string;
  integration_mode: ContextDeliveryMode;
  delivery_point: string;
  status: "DELIVERED" | "FAILED";
  failure_code: string | null;
  failure_reason: string | null;
  source_fingerprint: string;
  created_at: string;
}

function itemFromRow(row: ItemRow): ContextPacketItem {
  return {
    rank: row.rank, sourceType: row.source_type, sourceId: row.source_id, category: row.category,
    priority: row.priority, score: row.score_milli, estimatedTokens: row.estimated_tokens,
    reason: row.reason, content: row.content, truncated: row.truncated === 1,
  };
}

export interface RetrievalRecord {
  id: string;
  query: string;
  candidateCount: number;
  selectedCount: number;
  candidateTokens: number;
  selectedTokens: number;
  latencyMs: number;
  budgets: Record<string, { used: number; limit: number }>;
  excluded: ContextExplanation["excluded"];
  candidateMemoryIds: string[];
}

export class ContextPacketRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  save(projectId: string, input: {
    taskId?: string; executionRunId?: string; currentRequest: string; provider?: string;
    maxTokens: number; estimatedTokens: number; packetHash: string; rendered: string; durableRendered: string;
    items: ContextPacketItem[]; retrieval: RetrievalRecord;
  }): ContextPacket {
    const duplicate = this.#database.prepare("SELECT id FROM context_packets WHERE project_id = ? AND packet_hash = ?")
      .get(projectId, input.packetHash) as { id: string } | undefined;
    if (duplicate) return this.require(projectId, duplicate.id);
    const id = randomUUID();
    const now = new Date().toISOString();
    const version = input.taskId
      ? Number((this.#database.prepare("SELECT coalesce(max(version), 0) + 1 AS version FROM context_packets WHERE project_id = ? AND task_id = ?")
        .get(projectId, input.taskId) as { version: number }).version)
      : 1;
    inImmediateTransaction(this.#database, () => {
      this.#database.prepare(`
        INSERT INTO retrieval_runs(
          id, project_id, task_id, query, strategy_version, candidate_count, selected_count,
          candidate_tokens, selected_tokens, latency_ms, budget_json, exclusions_json, created_at
        ) VALUES (?, ?, ?, ?, 'context-planner-v1', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.retrieval.id, projectId, input.taskId ?? null, input.retrieval.query,
        input.retrieval.candidateCount, input.retrieval.selectedCount, input.retrieval.candidateTokens,
        input.retrieval.selectedTokens, input.retrieval.latencyMs, JSON.stringify(input.retrieval.budgets),
        JSON.stringify(input.retrieval.excluded), now,
      );
      this.#database.prepare(`
        INSERT INTO context_packets(
          id, project_id, task_id, execution_run_id, retrieval_run_id, version, current_request,
          provider, max_tokens, estimated_tokens, packet_hash, rendered_text, structured_payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, projectId, input.taskId ?? null, input.executionRunId ?? null, input.retrieval.id, version,
        `sha256:${createHash("sha256").update(input.currentRequest).digest("hex")}`,
        input.provider ?? null, input.maxTokens, input.estimatedTokens,
        input.packetHash, input.durableRendered, JSON.stringify({ items: input.items }), now,
      );
      const insertItem = this.#database.prepare(`
        INSERT INTO context_packet_items(
          packet_id, rank, source_type, source_id, category, priority, score_milli,
          estimated_tokens, reason, content, truncated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of input.items) {
        insertItem.run(
          id, item.rank, item.sourceType, item.sourceId, item.category, item.priority, item.score,
          item.estimatedTokens, item.reason, item.content, item.truncated ? 1 : 0,
        );
      }
      const candidateMemoryIds = [...new Set(input.retrieval.candidateMemoryIds)].slice(0, 100);
      const selectedMemoryIds = new Set(input.items
        .filter((item) => item.sourceType === "MEMORY")
        .map((item) => item.sourceId));
      const noteCandidate = this.#database.prepare(`
        UPDATE knowledge_usage_stats
        SET candidate_count = candidate_count + 1, last_candidate_at = ?
        WHERE knowledge_id = ?
          AND EXISTS (SELECT 1 FROM knowledge_units WHERE id = ? AND project_id = ?)
      `);
      const noteSelected = this.#database.prepare(`
        UPDATE knowledge_usage_stats
        SET selected_count = selected_count + 1, last_selected_at = ?
        WHERE knowledge_id = ?
          AND EXISTS (SELECT 1 FROM knowledge_units WHERE id = ? AND project_id = ?)
      `);
      for (const memoryId of candidateMemoryIds) {
        noteCandidate.run(now, memoryId, memoryId, projectId);
        if (selectedMemoryIds.has(memoryId)) noteSelected.run(now, memoryId, memoryId, projectId);
      }
    });
    return this.require(projectId, id);
  }

  get(projectId: string, packetId: string): ContextPacket | undefined {
    const row = this.#database.prepare("SELECT * FROM context_packets WHERE project_id = ? AND id = ?")
      .get(projectId, packetId) as PacketRow | undefined;
    if (!row) return undefined;
    const items = this.#database.prepare("SELECT * FROM context_packet_items WHERE packet_id = ? ORDER BY rank")
      .all(packetId) as unknown as ItemRow[];
    return {
      id: row.id, projectId: row.project_id, ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.execution_run_id ? { executionRunId: row.execution_run_id } : {}), version: row.version,
      currentRequest: row.current_request, ...(row.provider ? { provider: row.provider } : {}),
      maxTokens: row.max_tokens, estimatedTokens: row.estimated_tokens, retrievalRunId: row.retrieval_run_id,
      packetHash: row.packet_hash, rendered: row.rendered_text, items: items.map(itemFromRow), createdAt: row.created_at,
    };
  }

  require(projectId: string, packetId: string): ContextPacket {
    const packet = this.get(projectId, packetId);
    if (!packet) throw new Error(`Context packet not found: ${packetId}`);
    return packet;
  }

  latest(projectId: string): ContextPacket | undefined {
    const row = this.#database.prepare(
      "SELECT id FROM context_packets WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ).get(projectId) as { id: string } | undefined;
    return row ? this.get(projectId, row.id) : undefined;
  }

  explain(projectId: string, packetId: string): ContextExplanation {
    const packet = this.require(projectId, packetId);
    const retrieval = this.#database.prepare("SELECT budget_json, exclusions_json FROM retrieval_runs WHERE project_id = ? AND id = ?")
      .get(projectId, packet.retrievalRunId) as { budget_json: string; exclusions_json: string };
    return {
      packet,
      receipt: this.receipt(projectId, packetId),
      budgetByCategory: JSON.parse(retrieval.budget_json) as ContextExplanation["budgetByCategory"],
      excluded: JSON.parse(retrieval.exclusions_json) as ContextExplanation["excluded"],
    };
  }

  recordDelivery(projectId: string, packetId: string, input: {
    provider: string;
    integrationMode: ContextDeliveryMode;
    deliveryPoint: string;
    status: "DELIVERED" | "FAILED";
    sourceFingerprint: string;
    failureCode?: string;
    failureReason?: string;
  }): ContextReceipt {
    this.require(projectId, packetId);
    const values = [input.provider, input.deliveryPoint, input.sourceFingerprint, input.failureCode, input.failureReason]
      .filter((value): value is string => value !== undefined);
    if (values.some((value) => value.length === 0 || value.length > 2_048)) {
      throw new Error("Context delivery fields must contain between 1 and 2048 characters.");
    }
    if (input.status === "FAILED" && !input.failureCode) {
      throw new Error("A failed Context delivery requires a failure code.");
    }
    if (input.status === "DELIVERED" && (input.failureCode || input.failureReason)) {
      throw new Error("A successful Context delivery cannot contain failure details.");
    }
    const existing = this.#database.prepare(`
      SELECT * FROM context_deliveries WHERE project_id = ? AND source_fingerprint = ?
    `).get(projectId, input.sourceFingerprint) as DeliveryRow | undefined;
    if (existing) {
      if (existing.packet_id !== packetId || existing.status !== input.status) {
        throw new Error("Context delivery fingerprint is already associated with another outcome.");
      }
      return this.receipt(projectId, packetId);
    }
    this.#database.prepare(`
      INSERT INTO context_deliveries(
        id, project_id, packet_id, provider, integration_mode, delivery_point,
        status, failure_code, failure_reason, source_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), projectId, packetId, input.provider, input.integrationMode, input.deliveryPoint,
      input.status, input.failureCode ?? null, input.failureReason ?? null, input.sourceFingerprint,
      new Date().toISOString(),
    );
    return this.receipt(projectId, packetId);
  }

  receipt(projectId: string, packetId: string): ContextReceipt {
    const packet = this.require(projectId, packetId);
    const retrieval = this.#database.prepare(`
      SELECT candidate_count FROM retrieval_runs WHERE project_id = ? AND id = ?
    `).get(projectId, packet.retrievalRunId) as { candidate_count: number };
    const sourceCounts: ContextReceipt["sourceCounts"] = { TASK: 0, CHECKPOINT: 0, MEMORY: 0 };
    for (const item of packet.items) sourceCounts[item.sourceType] += 1;
    const delivery = this.#database.prepare(`
      SELECT * FROM context_deliveries
      WHERE project_id = ? AND packet_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(projectId, packetId) as DeliveryRow | undefined;
    const checkpointId = packet.items.find((item) => item.sourceType === "CHECKPOINT")?.sourceId;
    return {
      packetId: packet.id,
      projectId,
      ...(packet.taskId ? { taskId: packet.taskId } : {}),
      ...(checkpointId ? { checkpointId } : {}),
      ...(delivery?.provider ?? packet.provider ? { provider: delivery?.provider ?? packet.provider } : {}),
      ...(delivery ? { integrationMode: delivery.integration_mode, deliveryPoint: delivery.delivery_point } : {}),
      status: delivery?.status ?? "BUILT",
      candidateCount: retrieval.candidate_count,
      selectedCount: packet.items.length,
      selectedMemoryCount: sourceCounts.MEMORY,
      sourceCounts,
      estimatedTokens: packet.estimatedTokens,
      builtAt: packet.createdAt,
      ...(delivery ? { deliveredAt: delivery.created_at } : {}),
      ...(delivery?.failure_code ? { failureCode: delivery.failure_code } : {}),
      ...(delivery?.failure_reason ? { failureReason: delivery.failure_reason } : {}),
    };
  }
}
