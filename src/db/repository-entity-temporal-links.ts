/**
 * EXP-21: Per-entity temporal linkage repository.
 *
 * Insert one row per (entity, fact) pair so retrieval can walk a sparse
 * per-entity timeline ordered by `created_at`. The table is keyed by
 * lowercase entity name (TEXT) so the writer doesn't need to consult the
 * `entities` table — entity extraction in `extraction.ts` already produces
 * canonical names, and we want the linkage to work even when the entity
 * graph is disabled.
 */

import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export interface StoreTemporalLinkInput {
  userId: string;
  entityId: string;
  factId: string;
  createdAt?: Date;
}

export interface EntityTemporalLinkRow {
  fact_id: string;
  parent_memory_id: string;
  created_at: Date;
}

/** Insert one linkage row per input. Caller dedupes (entity, fact) pairs. */
export async function storeEntityTemporalLinks(
  queryable: Queryable,
  links: StoreTemporalLinkInput[],
): Promise<number> {
  if (links.length === 0) return 0;
  let inserted = 0;
  for (const link of links) {
    const result = await queryable.query(
      `INSERT INTO atomic_entity_temporal_links (user_id, entity_id, fact_id, created_at)
       VALUES ($1, $2, $3, $4)`,
      [
        link.userId,
        link.entityId,
        link.factId,
        (link.createdAt ?? new Date()).toISOString(),
      ],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

/**
 * Fetch the per-entity temporal link list for a single entity. Joined to
 * `memory_atomic_facts` to surface the `parent_memory_id`, which is the
 * id used as the SearchResult key by the rest of the pipeline.
 *
 * Ordered by `created_at ASC` so position 0 is the chronologically first
 * fact mentioning this entity. Callers that want most-recent-first can
 * reverse — the index supports both directions.
 */
export async function listEntityTemporalLinks(
  queryable: Queryable,
  userId: string,
  entityId: string,
  limit: number,
): Promise<EntityTemporalLinkRow[]> {
  const result = await queryable.query(
    `SELECT l.fact_id, f.parent_memory_id, l.created_at
       FROM atomic_entity_temporal_links l
       JOIN memory_atomic_facts f ON f.id = l.fact_id
      WHERE l.user_id = $1 AND l.entity_id = $2
      ORDER BY l.created_at ASC
      LIMIT $3`,
    [userId, entityId, limit],
  );
  return result.rows.map((row) => ({
    fact_id: String(row.fact_id),
    parent_memory_id: String(row.parent_memory_id),
    created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  }));
}
