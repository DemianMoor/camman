// Pure formatter for the Telegram batch-completion summary. Kept separate so it's
// unit-testable without DB/network. Line-type mix mirrors the brief's example;
// carrier Unknown/Unmapped are looked-up states (Unidentified can't occur in a
// batch result — it means "never looked up").
export interface BatchSummaryStats {
  trigger: string;
  orgName: string;
  total: number;
  cacheHits: number;
  processed: number; // completed lookups (done)
  failed: number;
  lineTypeCounts: Record<string, number>; // mobile/landline/voip/toll_free/unknown
  actualCostUsd: number;
  balanceUsd: number | null;
}

function pct(n: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

export function formatBatchSummary(s: BatchSummaryStats): string {
  const done = s.processed;
  const lt = s.lineTypeCounts;
  const parts = [
    `${pct(lt.mobile ?? 0, done)} mobile`,
    `${pct(lt.landline ?? 0, done)} landline (N/A)`,
    `${pct(lt.voip ?? 0, done)} VoIP`,
    `${pct(lt.toll_free ?? 0, done)} toll-free`,
    `${pct(lt.unknown ?? 0, done)} unknown`,
  ];
  const bal = s.balanceUsd == null ? "n/a" : `$${s.balanceUsd.toFixed(2)}`;
  return (
    `📇 Lookup batch complete (${s.trigger}, ${s.orgName}): ` +
    `${s.total.toLocaleString()} numbers → ${s.processed.toLocaleString()} new, ${s.cacheHits.toLocaleString()} cached.\n` +
    `Results: ${parts.join(", ")}. Failed: ${s.failed}. ` +
    `Actual cost: $${s.actualCostUsd.toFixed(2)}. Telnyx balance: ${bal}.`
  );
}
