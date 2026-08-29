import type { DatabaseSync } from "node:sqlite";
import { inImmediateTransaction } from "./sqlite-transaction.js";

/** Maintains the derived FTS document. Canonical knowledge never depends on it. */
export class KnowledgeSearchIndex {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  refresh(knowledgeId: string): void {
    const row = this.#database.prepare(`
      SELECT k.id, k.summary, k.body, k.kind,
        coalesce((SELECT group_concat(e.display_name || ' ' || e.canonical_key, ' ')
          FROM knowledge_entities ke JOIN entities e ON e.id = ke.entity_id
          WHERE ke.knowledge_id = k.id), '') AS entity_text,
        coalesce((SELECT group_concat(a.repo_relative_path || ' ' || coalesce(a.symbol, ''), ' ')
          FROM knowledge_anchors a WHERE a.knowledge_id = k.id), '') AS anchor_text,
        trim(coalesce(k.scope_kind, '') || ' ' || coalesce(k.scope_ref, '')) AS scope_text
      FROM knowledge_units k WHERE k.id = ?
    `).get(knowledgeId) as SearchDocumentRow | undefined;
    if (!row) {
      this.#database.prepare("DELETE FROM knowledge_search_documents WHERE knowledge_id = ?").run(knowledgeId);
      return;
    }
    this.#database.prepare(`
      INSERT INTO knowledge_search_documents(
        knowledge_id, summary, body, kind, entity_text, anchor_text, scope_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(knowledge_id) DO UPDATE SET
        summary = excluded.summary, body = excluded.body, kind = excluded.kind,
        entity_text = excluded.entity_text, anchor_text = excluded.anchor_text,
        scope_text = excluded.scope_text
    `).run(row.id, row.summary, row.body, row.kind, row.entity_text, row.anchor_text, row.scope_text);
  }

  rebuild(force = false): void {
    const knowledgeCount = this.#count("knowledge_units");
    const documentCount = this.#count("knowledge_search_documents");
    if (!force && knowledgeCount === documentCount) return;
    inImmediateTransaction(this.#database, () => {
      this.#database.exec("DELETE FROM knowledge_search_documents");
      const ids = this.#database.prepare("SELECT id FROM knowledge_units ORDER BY id").all() as Array<{ id: string }>;
      for (const row of ids) this.refresh(row.id);
    });
  }

  #count(table: "knowledge_units" | "knowledge_search_documents"): number {
    const row = this.#database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  }
}

interface SearchDocumentRow {
  id: string;
  summary: string;
  body: string;
  kind: string;
  entity_text: string;
  anchor_text: string;
  scope_text: string;
}
