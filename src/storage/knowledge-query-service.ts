import type { DatabaseSync } from "node:sqlite";
import type { Memory, MemorySearchResult, MemoryType } from "../domain/memory.js";
import { hydrateMemories, type MemoryProjectionRow } from "./memory-read-model.js";

/**
 * Query-side service for hybrid lexical, entity, graph and temporal retrieval.
 * It does not mutate canonical knowledge or own transaction boundaries.
 */
export class KnowledgeQueryService {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  search(projectId: string, query: string, limit: number): MemorySearchResult[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const seeds = this.#seedCandidates(projectId, query, match, boundedLimit);
    if (seeds.size === 0) return [];
    this.#expandRelations(seeds);

    const historical = isHistoricalQuery(query);
    const ids = [...seeds.keys()].slice(0, 250);
    const temporalNow = new Date().toISOString();
    const rows = this.#database.prepare(`
      SELECT * FROM memory_projection
      WHERE project_id = ? AND id IN (${placeholders(ids)})
        AND completion_state = 'OPEN'
        AND (${historical ? "lifecycle_status IN ('ACTIVE','SUPERSEDED')" : "lifecycle_status = 'ACTIVE'"})
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (${historical ? "1 = 1" : "valid_to IS NULL OR valid_to > ?"})
    `).all(projectId, ...ids, temporalNow, ...(historical ? [] : [temporalNow])) as unknown as MemoryProjectionRow[];
    rows.sort((left, right) => compareCandidates(left, right, seeds));
    return hydrateMemories(this.#database, rows.slice(0, boundedLimit))
      .map((memory, index) => ({ memory, rank: index + 1 }));
  }

  recent(projectId: string, limit: number): MemorySearchResult[] {
    const now = new Date().toISOString();
    const rows = this.#database.prepare(`
      SELECT * FROM memory_projection
      WHERE project_id = ? AND lifecycle_status = 'ACTIVE' AND completion_state = 'OPEN'
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY CASE correctness_risk WHEN 'LOW' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
        relevance_milli DESC, importance_milli DESC, updated_at DESC, id ASC LIMIT ?
    `).all(projectId, now, now, limit) as unknown as MemoryProjectionRow[];
    return hydrateMemories(this.#database, rows).map((memory, index) => ({ memory, rank: index + 1 }));
  }

  list(
    projectId: string,
    options: { query?: string; status?: Memory["lifecycleStatus"]; type?: MemoryType; limit: number; offset: number },
  ): Memory[] {
    const limit = Math.max(1, Math.min(options.limit, 100));
    const offset = Math.max(0, options.offset);
    const query = options.query?.trim();
    const rows = query
      ? this.#searchList(projectId, query, options, limit, offset)
      : this.#plainList(projectId, options, limit, offset);
    return hydrateMemories(this.#database, rows);
  }

  #seedCandidates(projectId: string, query: string, match: string, limit: number): Map<string, number> {
    const seeds = new Map<string, number>();
    const ftsRows = this.#database.prepare(`
      SELECT d.knowledge_id, bm25(knowledge_fts, 8.0, 3.0, 1.0, 5.0, 4.0, 2.0) AS fts_rank
      FROM knowledge_fts
      JOIN knowledge_search_documents d ON d.row_id = knowledge_fts.rowid
      JOIN knowledge_units k ON k.id = d.knowledge_id
      WHERE knowledge_fts MATCH ? AND k.project_id = ?
      ORDER BY fts_rank LIMIT ?
    `).all(match, projectId, limit * 4) as Array<{ knowledge_id: string; fts_rank: number }>;
    for (const [index, row] of ftsRows.entries()) seeds.set(row.knowledge_id, index + 10);

    const terms = query.normalize("NFKC").match(/[\p{L}\p{N}_./:#-]{2,}/gu)?.slice(0, 10) ?? [];
    if (terms.length === 0) return seeds;
    const clauses = terms.map(() => "(lower(e.display_name) LIKE ? OR lower(e.canonical_key) LIKE ?)").join(" OR ");
    const params = terms.flatMap((term) => [`%${term.toLowerCase()}%`, `%${term.toLowerCase()}%`]);
    const entityRows = this.#database.prepare(`
      SELECT DISTINCT ke.knowledge_id
      FROM entities e JOIN knowledge_entities ke ON ke.entity_id = e.id
      WHERE e.project_id = ? AND (${clauses}) LIMIT ?
    `).all(projectId, ...params, limit * 4) as Array<{ knowledge_id: string }>;
    for (const [index, row] of entityRows.entries()) {
      seeds.set(row.knowledge_id, Math.min(seeds.get(row.knowledge_id) ?? Number.POSITIVE_INFINITY, index));
    }
    return seeds;
  }

  #expandRelations(seeds: Map<string, number>): void {
    const seedIds = [...seeds.keys()].slice(0, 200);
    const marker = placeholders(seedIds);
    const expanded = this.#database.prepare(`
      SELECT from_knowledge_id AS seed_id, to_knowledge_id AS related_id, relation_type
      FROM knowledge_relations WHERE from_knowledge_id IN (${marker})
        AND relation_type IN ('SUPERSEDES','CONTRADICTS','EXTENDS','DEPENDS_ON')
      UNION ALL
      SELECT to_knowledge_id, from_knowledge_id, relation_type
      FROM knowledge_relations WHERE to_knowledge_id IN (${marker})
        AND relation_type IN ('SUPERSEDES','CONTRADICTS','EXTENDS','DEPENDS_ON')
    `).all(...seedIds, ...seedIds) as Array<{ seed_id: string; related_id: string; relation_type: string }>;
    for (const relation of expanded) {
      const penalty = relation.relation_type === "SUPERSEDES" ? 20 : 40;
      seeds.set(relation.related_id, Math.min(
        seeds.get(relation.related_id) ?? Number.POSITIVE_INFINITY,
        (seeds.get(relation.seed_id) ?? 100) + penalty,
      ));
    }
  }

  #searchList(
    projectId: string,
    query: string,
    options: { status?: Memory["lifecycleStatus"]; type?: MemoryType },
    limit: number,
    offset: number,
  ): MemoryProjectionRow[] {
    const match = toFtsQuery(query);
    if (!match) return [];
    return this.#database.prepare(`
      SELECT m.* FROM knowledge_fts
      JOIN knowledge_search_documents d ON d.row_id = knowledge_fts.rowid
      JOIN memory_projection m ON m.id = d.knowledge_id
      WHERE knowledge_fts MATCH ? AND m.project_id = ?
        AND (? IS NULL OR m.lifecycle_status = ?)
        AND (? IS NULL OR m.type = ?)
      ORDER BY bm25(knowledge_fts, 8.0, 3.0, 1.0, 5.0, 4.0, 2.0), m.updated_at DESC, m.id ASC
      LIMIT ? OFFSET ?
    `).all(match, projectId, options.status ?? null, options.status ?? null,
      options.type ?? null, options.type ?? null, limit, offset) as unknown as MemoryProjectionRow[];
  }

  #plainList(
    projectId: string,
    options: { status?: Memory["lifecycleStatus"]; type?: MemoryType },
    limit: number,
    offset: number,
  ): MemoryProjectionRow[] {
    return this.#database.prepare(`
      SELECT * FROM memory_projection WHERE project_id = ?
        AND (? IS NULL OR lifecycle_status = ?)
        AND (? IS NULL OR type = ?)
      ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?
    `).all(projectId, options.status ?? null, options.status ?? null,
      options.type ?? null, options.type ?? null, limit, offset) as unknown as MemoryProjectionRow[];
  }
}

export function toFtsQuery(input: string): string {
  const terms = input.normalize("NFKC").match(/[\p{L}\p{N}_./:-]+/gu)?.slice(0, 20) ?? [];
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

function isHistoricalQuery(query: string): boolean {
  return /\b(before|previous|formerly|history|historical|used to)\b|以前|过去|历史|曾经|原来/iu.test(query);
}

function compareCandidates(left: MemoryProjectionRow, right: MemoryProjectionRow, seeds: Map<string, number>): number {
  const lifecycle = (left.lifecycle_status === "ACTIVE" ? 0 : 100) - (right.lifecycle_status === "ACTIVE" ? 0 : 100);
  if (lifecycle !== 0) return lifecycle;
  const risks: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  const risk = (risks[left.correctness_risk] ?? 3) - (risks[right.correctness_risk] ?? 3);
  if (risk !== 0) return risk;
  return (seeds.get(left.id) ?? 1_000) - (seeds.get(right.id) ?? 1_000)
    || right.relevance_milli - left.relevance_milli
    || right.importance_milli - left.importance_milli
    || right.updated_at.localeCompare(left.updated_at)
    || left.id.localeCompare(right.id);
}
