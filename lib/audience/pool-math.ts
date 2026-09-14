// Pure arithmetic behind GET /api/audience/pools. No imports, so
// scripts/test-audience-pool-math.ts runs without a database.
//
// The rollup stores, per contact group and per offer, how many eligible contacts
// sit in each REST BUCKET: whole days since the contact's last sent message of
// ANY offer, 0..30, with bucket 31 meaning "31 days or more, or never messaged".
// "Rested for N days" is then every bucket >= N, exact for any N in 0..30.

export const REST_BUCKETS = 32;
export const REST_DAYS_MAX = 30;
export const REST_DAYS_DEFAULT = 7;

/** Contacts per rest bucket; index = whole days since last send (31 = 31+ or never). */
export type RestHistogram = number[];

/** Histograms keyed by contact group id, plus "total" for the whole org. */
export type HistogramsByGroup = Record<string, RestHistogram>;

export interface OfferHistograms {
  /** Eligible contacts with at least one sent message of the offer. */
  received: HistogramsByGroup;
  /** Of those: no human click on the offer and no conversion on it. */
  received_not_clicked: HistogramsByGroup;
  /** Of those: a human click on the offer and no conversion on it. */
  clickers_non_buyers: HistogramsByGroup;
}

export interface PoolCounts {
  group_total_eligible: number;
  never_received: number;
  never_received_rested: number;
  received_not_clicked_rested: number;
  clickers_non_buyers: number;
  clickers_non_buyers_rested: number;
}

/** Sum of the buckets >= restDays; restDays 0 sums the whole histogram. */
export function restedCount(h: RestHistogram | undefined, restDays: number): number {
  if (!h) return 0;
  let n = 0;
  for (let b = restDays; b < h.length; b++) n += h[b];
  return n;
}

/**
 * The six pool numbers for one key ("total" or a group id). `offer` is undefined
 * for an offer that has never sent: every received set is empty.
 */
export function poolCounts(
  base: HistogramsByGroup,
  offer: OfferHistograms | undefined,
  key: string,
  restDays: number,
): PoolCounts {
  const eligible = restedCount(base[key], 0);
  return {
    group_total_eligible: eligible,
    never_received: eligible - restedCount(offer?.received[key], 0),
    never_received_rested:
      restedCount(base[key], restDays) - restedCount(offer?.received[key], restDays),
    received_not_clicked_rested: restedCount(offer?.received_not_clicked[key], restDays),
    clickers_non_buyers: restedCount(offer?.clickers_non_buyers[key], 0),
    clickers_non_buyers_rested: restedCount(offer?.clickers_non_buyers[key], restDays),
  };
}
