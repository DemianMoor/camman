// Pure helpers for the creative dimension of GET /api/reports/performance: RPM,
// server-side sorting, the min_sent hide and the send-day fields. No server
// imports, so scripts/test-creative-rows.ts runs without a database.
import type { CreativeSortKey } from "./report-dimensions";

export interface CreativeSortable {
  key: string;
  sent: number;
  revenue: number;
  rpm: number | null;
  click_to_reach_pct: number | null;
}

export interface SendDays {
  first_sent_date: string | null;
  last_sent_date: string | null;
  distinct_send_days: number;
}

/** Revenue per 1,000 messages sent, 2 decimals; null when nothing was sent. */
export function rpmOf(revenue: number, sent: number): number | null {
  return sent > 0 ? Math.round((revenue / sent) * 100_000) / 100 : null;
}

/** Descending by `sortBy`, nulls last, ties by sent desc then key. Returns a copy. */
export function sortCreativeRows<T extends CreativeSortable>(rows: T[], sortBy: CreativeSortKey): T[] {
  return [...rows].sort((a, b) => {
    const va = a[sortBy];
    const vb = b[sortBy];
    if (va == null && vb != null) return 1;
    if (vb == null && va != null) return -1;
    if (va != null && vb != null && va !== vb) return vb - va;
    return b.sent - a.sent || a.key.localeCompare(b.key);
  });
}

/** Rows below the threshold are hidden, and counted so the caller can see it. */
export function hideBelowMinSent<T extends { sent: number }>(
  rows: T[],
  minSent: number,
): { rows: T[]; hidden: number } {
  const kept = rows.filter((r) => r.sent >= minSent);
  return { rows: kept, hidden: rows.length - kept.length };
}

/** First / last ET send day and the number of distinct days, from YYYY-MM-DD strings. */
export function sendDaysOf(days: string[]): SendDays {
  if (days.length === 0) return { first_sent_date: null, last_sent_date: null, distinct_send_days: 0 };
  const unique = [...new Set(days)].sort();
  return {
    first_sent_date: unique[0],
    last_sent_date: unique[unique.length - 1],
    distinct_send_days: unique.length,
  };
}
