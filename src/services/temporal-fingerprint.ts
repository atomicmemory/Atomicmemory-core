/**
 * Normalized content fingerprints and log-spaced recency bins for temporal
 * retrieval protection.
 *
 * Different rows can duplicate the same event text, so protection needs to
 * reason about content identity, not row identity (`buildTemporalFingerprint`).
 *
 * Recency bins are a coarse, log-spaced quantization of `now - createdAt`.
 * They give the search pipeline a scale-invariant signal it can match
 * against keywords like "recently" or "last week" without locking the
 * comparison to a specific timestamp. Bins are recomputed at retrieval
 * time against the current `now`; persisted breadcrumbs go stale and
 * MUST NOT be trusted for ranking decisions.
 */

export function buildTemporalFingerprint(content: string): string {
  return content
    .replace(/^As of [^,]+,?\s*/i, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Closed set of recency bin labels, ordered oldest → youngest is reversed:
 * `BIN_LADDER` is youngest-first so the first matching upper bound wins.
 * `'older'` is the implicit catch-all for ages beyond 100 days.
 */
export type RecencyBin = '1m' | '10m' | '1h' | '10h' | '1d' | '10d' | '100d' | 'older';

interface BinRung {
  readonly label: Exclude<RecencyBin, 'older'>;
  readonly ms: number;
}

const BIN_LADDER: readonly BinRung[] = [
  { label: '1m', ms: 60_000 },
  { label: '10m', ms: 600_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '10h', ms: 36_000_000 },
  { label: '1d', ms: 86_400_000 },
  { label: '10d', ms: 864_000_000 },
  { label: '100d', ms: 8_640_000_000 },
] as const;

const BIN_ORDER: readonly RecencyBin[] = [
  '1m', '10m', '1h', '10h', '1d', '10d', '100d', 'older',
];

/**
 * Map a fact's age (`now - createdAt`) onto the log-spaced bin ladder.
 * Negative ages clamp to zero so future-dated facts land in `'1m'`
 * rather than producing NaN.
 */
export function assignRecencyBin(createdAt: Date, now: Date): RecencyBin {
  const ageMs = Math.max(0, now.getTime() - createdAt.getTime());
  for (const rung of BIN_LADDER) {
    if (ageMs <= rung.ms) return rung.label;
  }
  return 'older';
}

/**
 * Affinity between a query bin and a fact bin.
 * - 1.0: exact bin match
 * - 0.5: adjacent bin in `BIN_ORDER` (e.g. `1h` ↔ `10h`, `100d` ↔ `older`)
 * - 0.0: otherwise
 */
export function computeBinAffinity(queryBin: RecencyBin, factBin: RecencyBin): number {
  if (queryBin === factBin) return 1;
  const qi = BIN_ORDER.indexOf(queryBin);
  const fi = BIN_ORDER.indexOf(factBin);
  if (qi < 0 || fi < 0) return 0;
  return Math.abs(qi - fi) === 1 ? 0.5 : 0;
}

export const RECENCY_BIN_LABELS: readonly RecencyBin[] = BIN_ORDER;
