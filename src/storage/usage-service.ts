import type { DatabaseSync } from "node:sqlite";
import type { TokenSavingsStats } from "../application/ports.js";
import type { Memory } from "../domain/memory.js";
import { KnowledgeRepository, validateReason } from "./knowledge-repository.js";
import { inImmediateTransaction } from "./sqlite-transaction.js";

/** Owns usage feedback and token-savings accounting. */
export class UsageService {
  readonly #database: DatabaseSync;
  readonly #knowledge: KnowledgeRepository;

  constructor(database: DatabaseSync, knowledge: KnowledgeRepository) {
    this.#database = database;
    this.#knowledge = knowledge;
  }

  noteContextUsage(projectId: string, candidateIds: string[], selectedIds: string[], tokens: TokenMeasurement, now: string): void {
    const candidates = [...new Set(candidateIds)].slice(0, 50);
    const selected = [...new Set(selectedIds)].filter((id) => candidates.includes(id)).slice(0, 50);
    if (!Number.isInteger(tokens.baseline) || !Number.isInteger(tokens.context)
      || tokens.context < 0 || tokens.baseline < tokens.context || tokens.baseline > 10_000_000) {
      throw new Error("Context token metrics are invalid.");
    }
    inImmediateTransaction(this.#database, () => {
      const candidateStatement = this.#database.prepare(`
        UPDATE knowledge_usage_stats SET candidate_count = candidate_count + 1, last_candidate_at = ?
        WHERE knowledge_id = ? AND EXISTS (SELECT 1 FROM knowledge_units WHERE id = ? AND project_id = ?)
      `);
      for (const id of candidates) candidateStatement.run(now, id, id, projectId);
      const selectedStatement = this.#database.prepare(`
        UPDATE knowledge_usage_stats SET selected_count = selected_count + 1, last_selected_at = ?
        WHERE knowledge_id = ? AND EXISTS (SELECT 1 FROM knowledge_units WHERE id = ? AND project_id = ?)
      `);
      for (const id of selected) selectedStatement.run(now, id, id, projectId);
      this.#database.prepare(`
        INSERT INTO context_token_savings(
          project_id, context_pack_count, candidate_count, selected_count,
          baseline_tokens, context_tokens, estimated_saved_tokens, measurement_started_at, last_context_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          context_pack_count = context_pack_count + 1,
          candidate_count = candidate_count + excluded.candidate_count,
          selected_count = selected_count + excluded.selected_count,
          baseline_tokens = baseline_tokens + excluded.baseline_tokens,
          context_tokens = context_tokens + excluded.context_tokens,
          estimated_saved_tokens = estimated_saved_tokens + excluded.estimated_saved_tokens,
          last_context_at = excluded.last_context_at
      `).run(projectId, candidates.length, selected.length, tokens.baseline, tokens.context,
        tokens.baseline - tokens.context, now, now);
    });
  }

  tokenSavings(projectId: string): TokenSavingsStats {
    const row = this.#database.prepare("SELECT * FROM context_token_savings WHERE project_id = ?")
      .get(projectId) as TokenSavingsRow | undefined;
    if (!row) throw new Error(`Token savings are unavailable for project: ${projectId}`);
    return {
      contextPackCount: row.context_pack_count,
      candidateCount: row.candidate_count,
      selectedCount: row.selected_count,
      baselineTokens: row.baseline_tokens,
      contextTokens: row.context_tokens,
      estimatedSavedTokens: row.estimated_saved_tokens,
      measurementStartedAt: row.measurement_started_at,
      ...(row.last_context_at ? { lastContextAt: row.last_context_at } : {}),
      resetCount: row.reset_count,
    };
  }

  resetTokenSavings(projectId: string, now: string): TokenSavingsStats {
    const result = this.#database.prepare(`
      UPDATE context_token_savings SET context_pack_count = 0, candidate_count = 0, selected_count = 0,
        baseline_tokens = 0, context_tokens = 0, estimated_saved_tokens = 0,
        measurement_started_at = ?, last_context_at = NULL, reset_count = reset_count + 1
      WHERE project_id = ?
    `).run(now, projectId);
    if (Number(result.changes) !== 1) throw new Error(`Token savings are unavailable for project: ${projectId}`);
    return this.tokenSavings(projectId);
  }

  noteFeedback(projectId: string, memoryId: string, useful: boolean, reason: string): Memory {
    validateReason(reason, "Feedback");
    const memory = this.#knowledge.require(projectId, memoryId);
    const now = new Date().toISOString();
    const column = useful ? "positive_feedback_count" : "negative_feedback_count";
    inImmediateTransaction(this.#database, () => {
      this.#database.prepare(`UPDATE knowledge_usage_stats SET ${column} = ${column} + 1, last_feedback_at = ? WHERE knowledge_id = ?`)
        .run(now, memoryId);
      this.#knowledge.appendRevision(memory, `feedback:${useful ? "USEFUL" : "NOT_USEFUL"}:${reason.trim()}`, "HUMAN_CLI", now);
    });
    return this.#knowledge.require(projectId, memoryId);
  }
}

interface TokenMeasurement { baseline: number; context: number }
interface TokenSavingsRow {
  context_pack_count: number;
  candidate_count: number;
  selected_count: number;
  baseline_tokens: number;
  context_tokens: number;
  estimated_saved_tokens: number;
  measurement_started_at: string;
  last_context_at: string | null;
  reset_count: number;
}
