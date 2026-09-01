import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ContextExplanation, ContextPacket, ContextPacketItem } from "../domain/context-os.js";
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
      budgetByCategory: JSON.parse(retrieval.budget_json) as ContextExplanation["budgetByCategory"],
      excluded: JSON.parse(retrieval.exclusions_json) as ContextExplanation["excluded"],
    };
  }
}
