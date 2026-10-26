// Pure core of the apply-time skip preflight (scripts/check-migration-skip.ts).
//
// Drizzle applies a journal entry only when its `when` is STRICTLY greater than
// the newest `created_at` already in drizzle.__drizzle_migrations, and records
// created_at = that `when`. So an entry that is not applied and whose `when` is
// <= the newest applied one is never applied by any future run — silently.
//
// An entry counts as applied when its `when` matches a recorded created_at OR
// its file's sha256 matches a recorded hash (an applied migration whose `when`
// was bumped afterwards still matches by hash).

export interface JournalEntry {
  tag: string;
  when: number;
}
export interface AppliedRow {
  created_at: number;
  hash: string;
}

// KNOWN, VERIFIED DRIFT — per Supabase project ref, per migration tag, with the
// evidence. Only for a database where the migration's OBJECTS were checked to
// exist but its ledger row records an earlier draft (different `when` and
// hash). Production (rtdarhkkjwcetlmruftl) has no entries and must never get one:
// a real skip there is exactly what this preflight exists to stop.
export const ACCEPTED_DRIFT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // camman-v2 (preview), checked 2026-10-26.
  fdzxzxayhknywvmrhjcj: {
    "0182_conversion_reader_switch":
      "earlier draft applied as when 1792108800000 / hash 06523c02; keitaro_stage_results.pending_revenue and conversion_events_updated_at_idx present",
    "0219_contact_zip":
      "earlier draft applied as when 1795564800000 / hash 319bba9d; contact_attributes.zip present",
  },
};

export interface SkipReport {
  newestApplied: number | null;
  /** Not applied and not newer than the newest applied: would be skipped. */
  skipped: JournalEntry[];
  /** Would be skipped, but listed in ACCEPTED_DRIFT for this database. */
  accepted: JournalEntry[];
  /** Not applied and newer: what the next migrate will apply. */
  pending: JournalEntry[];
}

export function skipReport(
  journal: JournalEntry[],
  applied: AppliedRow[],
  hashOf: (tag: string) => string,
  acceptedTags: ReadonlySet<string>,
): SkipReport {
  const whens = new Set(applied.map((a) => Number(a.created_at)));
  const hashes = new Set(applied.map((a) => a.hash));
  const newestApplied = applied.length ? Math.max(...applied.map((a) => Number(a.created_at))) : null;
  const unapplied = journal.filter((e) => !whens.has(e.when) && !hashes.has(hashOf(e.tag)));
  const behind = unapplied.filter((e) => newestApplied != null && e.when <= newestApplied);
  return {
    newestApplied,
    skipped: behind.filter((e) => !acceptedTags.has(e.tag)),
    accepted: behind.filter((e) => acceptedTags.has(e.tag)),
    pending: unapplied.filter((e) => newestApplied == null || e.when > newestApplied),
  };
}

/** The project ref a connection string targets: pooler user `postgres.<ref>` or host `db.<ref>.supabase.co`. */
export function projectRefOf(databaseUrl: string): string | null {
  const u = new URL(databaseUrl);
  const m = `${decodeURIComponent(u.username)}|${u.hostname}`.match(/(?:postgres\.|db\.)([a-z0-9]{20})/);
  return m ? m[1] : null;
}
