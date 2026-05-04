/**
 * Repository for the Temporal Linkage List (TLL) — per-entity sparse graph
 * of event nodes connected by predecessor/successor edges.
 *
 * Purpose: maintain "what happened in what order, per entity" without
 * paying the full graph-DB cost. Each new memory referencing an entity
 * appends an event node; the predecessor pointer lets us traverse the
 * chain backward at query time for EO/MSR/TR questions.
 *
 * The CROME proposal calls this primitive necessary for temporal reasoning
 * at 10M scale; Mem0 explicitly admits their architecture lacks it.
 */

import pg from 'pg';

export interface TLLEvent {
  memoryId: string;
  predecessorMemoryId: string | null;
  observationDate: Date;
  positionInChain: number;
}

export class TllRepository {
  constructor(private pool: pg.Pool) {}

  /**
   * Append an event node to each entity's chain. Idempotent on
   * (user_id, entity_id, memory_id). Predecessor is the most-recent
   * existing event for the entity; position is len(chain).
   */
  async append(
    userId: string,
    memoryId: string,
    entityIds: string[],
    observationDate: Date,
  ): Promise<void> {
    if (entityIds.length === 0) return;
    const uniqueEntities = [...new Set(entityIds)];

    // Find current chain tip per entity in one query
    const tipResult = await this.pool.query(
      `SELECT entity_id,
              memory_id AS predecessor_memory_id,
              position_in_chain
       FROM temporal_linkage_list t1
       WHERE user_id = $1 AND entity_id = ANY($2::uuid[])
         AND position_in_chain = (
           SELECT MAX(position_in_chain)
           FROM temporal_linkage_list t2
           WHERE t2.user_id = t1.user_id AND t2.entity_id = t1.entity_id
         )`,
      [userId, uniqueEntities],
    );
    const tips = new Map<string, { predecessorId: string; position: number }>();
    for (const row of tipResult.rows) {
      tips.set(row.entity_id, {
        predecessorId: row.predecessor_memory_id,
        position: row.position_in_chain,
      });
    }

    // Batch insert
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const entityId of uniqueEntities) {
      const tip = tips.get(entityId);
      const predecessor = tip ? tip.predecessorId : null;
      const position = tip ? tip.position + 1 : 0;
      values.push(`($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5})`);
      params.push(userId, entityId, memoryId, predecessor, observationDate, position);
      p += 6;
    }
    await this.pool.query(
      `INSERT INTO temporal_linkage_list
        (user_id, entity_id, memory_id, predecessor_memory_id, observation_date, position_in_chain)
        VALUES ${values.join(', ')}
        ON CONFLICT (user_id, entity_id, memory_id) DO NOTHING`,
      params,
    );
  }

  /**
   * Get the full event chain for an entity, ordered chronologically.
   * Used for "list events in order" (EO) and "how did X evolve" (TR/MSR).
   */
  async chain(userId: string, entityId: string): Promise<TLLEvent[]> {
    const result = await this.pool.query(
      `SELECT memory_id, predecessor_memory_id, observation_date, position_in_chain
       FROM temporal_linkage_list
       WHERE user_id = $1 AND entity_id = $2
       ORDER BY position_in_chain ASC`,
      [userId, entityId],
    );
    return result.rows.map((row) => ({
      memoryId: row.memory_id,
      predecessorMemoryId: row.predecessor_memory_id,
      observationDate: row.observation_date,
      positionInChain: row.position_in_chain,
    }));
  }

  /**
   * Bulk: get chains for multiple entities. Returns memory_ids in order
   * across all entity chains, deduplicated. Used as a retrieval signal
   * for queries that span multiple entities (MSR).
   */
  async chainsFor(userId: string, entityIds: string[]): Promise<string[]> {
    if (entityIds.length === 0) return [];
    const result = await this.pool.query(
      `SELECT DISTINCT memory_id, observation_date
       FROM temporal_linkage_list
       WHERE user_id = $1 AND entity_id = ANY($2::uuid[])
       ORDER BY observation_date ASC`,
      [userId, [...new Set(entityIds)]],
    );
    return result.rows.map((row) => row.memory_id);
  }

  /**
   * Bulk-retrieve enriched event chains: per-entity ordered list of events
   * joined with memory content. Used by the event-chains HTTP endpoint and
   * by EO-shaped read paths that need content alongside chain position.
   *
   * Returns one entry per entity; entities with no events are dropped.
   * Within an entity, events are ordered by position_in_chain ASC.
   */
  async chainEventsForEntities(
    userId: string,
    entityIds: string[],
  ): Promise<Array<{
    entityId: string;
    events: Array<{
      memoryId: string;
      content: string;
      observationDate: Date;
      positionInChain: number;
      predecessorMemoryId: string | null;
    }>;
  }>> {
    if (entityIds.length === 0) return [];
    const unique = [...new Set(entityIds)];
    const result = await this.pool.query(
      `SELECT t.entity_id,
              t.memory_id,
              t.predecessor_memory_id,
              t.observation_date,
              t.position_in_chain,
              m.content
       FROM temporal_linkage_list t
       JOIN memories m ON m.id = t.memory_id
       WHERE t.user_id = $1
         AND t.entity_id = ANY($2::uuid[])
         AND m.deleted_at IS NULL
         AND m.status = 'active'
       ORDER BY t.entity_id, t.position_in_chain ASC`,
      [userId, unique],
    );
    const grouped = new Map<string, Array<{
      memoryId: string;
      content: string;
      observationDate: Date;
      positionInChain: number;
      predecessorMemoryId: string | null;
    }>>();
    for (const row of result.rows) {
      const list = grouped.get(row.entity_id) ?? [];
      list.push({
        memoryId: row.memory_id,
        content: row.content,
        observationDate: row.observation_date,
        positionInChain: row.position_in_chain,
        predecessorMemoryId: row.predecessor_memory_id,
      });
      grouped.set(row.entity_id, list);
    }
    return [...grouped.entries()].map(([entityId, events]) => ({ entityId, events }));
  }
}
