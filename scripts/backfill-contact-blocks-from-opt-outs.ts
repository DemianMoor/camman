// Backfill for migration 0237 (contact blocks), decision O2 + D5 of
// docs/superpowers/specs/2026-11-06-contact-blocks-soft-delete-design.md.
//
// Copies every phone that has an opt_outs row with reason 'suppressed' (the SMS
// blacklist / Global Suppression) or 'scrubbed' into the contact_blocks ledger
// as reason 'provider_list', source 'opt_outs backfill', created_at = the
// earliest such opt_outs row — and mirrors it onto contacts.blocked_at /
// block_reason (invariant D2). The opt_outs rows are NOT touched, so opt-out
// stats do not move.
//
// SEND EFFECT: none. Every contact touched already has an opt_outs row, which
// every selection path and the drain exclude. The 0237 trigger flips these
// contacts' messaging_status to 'blocked' — run this only AFTER the PR that
// teaches the "not eligible ≠ landline" readers about 'blocked' (spec §11), or
// the contacts page's eligible/not-applicable split will count them as eligible.
//
// The ledger key is contacts.phone_number (joined via opt_outs.contact_id), the
// exact key every import check uses — not opt_outs.phone_number.
//
// Idempotent: ON CONFLICT on the active-row unique index skips a phone that
// already has an active ledger row (of any reason); the contacts UPDATE only
// touches rows whose blocked_at is still NULL. Re-running after a partial run
// finishes the rest.
//
// Batches of 5,000 contacts, one transaction each, keyset by contact id.
// Prints contacts' HOT counters before and after (docs/07-conventions.md).
// ⚠️ pg_stat counters are flushed asynchronously (up to ~60 s on a busy server),
// so the "after" line printed at the end of a run can lag. The number to report
// is a --hot reading taken a few minutes AFTER the run.
//
// Attended only (CLAUDE.md §14): the owner typed "go now" in the session.
//
//   npx tsx scripts/backfill-contact-blocks-from-opt-outs.ts --hot      # print contacts HOT counters only (read-only)
//   npx tsx scripts/backfill-contact-blocks-from-opt-outs.ts            # dry run (read-only)
//   npx tsx scripts/backfill-contact-blocks-from-opt-outs.ts --apply    # write (05:00–05:50 UTC only)
//   … --apply --off-window   # owner-approved run OUTSIDE the window
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const APPLY = process.argv.includes("--apply");
const HOT_ONLY = process.argv.includes("--hot");
const OFF_WINDOW = process.argv.includes("--off-window");
const BATCH = 5000;
const REASONS = ["suppressed", "scrubbed"];

async function main() {
  const raw = process.env.DATABASE_URL!;
  const now = new Date();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (APPLY && OFF_WINDOW) {
    console.log(`⚠ --off-window: owner-approved run outside 05:00–05:50 UTC at ${now.toISOString()}`);
  }
  if (APPLY && !OFF_WINDOW && (minutes < 5 * 60 || minutes >= 5 * 60 + 50)) {
    console.error(`REFUSING — --apply runs only in the quiet window (start 05:00–05:50 UTC); now ${now.toISOString()}`);
    process.exit(1);
  }
  // Transaction pooler is fine: every batch is one short transaction and no
  // session-level SET is issued.
  const pg = postgres(raw, { prepare: false, max: 1 });
  console.log(`${APPLY ? "APPLYING to" : "DRY RUN against"} ${new URL(raw).hostname}\n`);

  const hot = async () =>
    ((await pg`
      SELECT n_tup_upd::bigint AS upd, n_tup_hot_upd::bigint AS hot,
             round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1)::float AS pct,
             n_dead_tup::bigint AS dead
      FROM pg_stat_user_tables WHERE relid = 'public.contacts'::regclass`) as unknown as
      { upd: string; hot: string; pct: number; dead: string }[])[0];

  try {
    const before = await hot();
    if (HOT_ONLY) {
      console.log(`contacts HOT now (${new Date().toISOString()}): ${before.hot}/${before.upd} updates (${before.pct}%), dead ${before.dead}`);
      return;
    }
    console.log(`contacts HOT before: ${before.hot}/${before.upd} updates (${before.pct}%), dead ${before.dead}`);

    const plan = ((await pg`
      WITH src AS (
        SELECT c.id AS contact_id, c.org_id, c.phone_number, c.blocked_at, c.archived_at
        FROM contacts c
        WHERE EXISTS (SELECT 1 FROM opt_outs o
                      WHERE o.contact_id = c.id AND o.org_id = c.org_id
                        AND o.reason = ANY(${REASONS}::text[]))
      )
      SELECT
        (SELECT count(*) FROM opt_outs WHERE reason = ANY(${REASONS}::text[]))::int AS opt_out_rows,
        count(*)::int AS contacts,
        count(DISTINCT (org_id, phone_number))::int AS phones,
        count(*) FILTER (WHERE blocked_at IS NOT NULL)::int AS already_blocked,
        count(*) FILTER (WHERE archived_at IS NOT NULL)::int AS archived,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM contact_blocks b
          WHERE b.org_id = src.org_id AND b.phone_number = src.phone_number AND b.released_at IS NULL
        ))::int AS phones_with_active_ledger_row
      FROM src`) as unknown as Record<string, number>[])[0];
    console.log(`plan: ${JSON.stringify(plan)}`);

    if (!APPLY) {
      console.log(`\nDRY RUN — nothing written. Re-run with --apply (attended, "go now").`);
      return;
    }

    let last = "00000000-0000-0000-0000-000000000000";
    let inserted = 0;
    let updated = 0;
    let batches = 0;
    for (;;) {
      const ids = ((await pg`
        SELECT DISTINCT o.contact_id FROM opt_outs o
        WHERE o.reason = ANY(${REASONS}::text[]) AND o.contact_id > ${last}::uuid
        ORDER BY o.contact_id LIMIT ${BATCH}`) as unknown as { contact_id: string }[]).map((r) => r.contact_id);
      if (ids.length === 0) break;
      last = ids[ids.length - 1];
      const r = await pg.begin(async (tx) => {
        const ins = await tx`
          WITH src AS (
            SELECT c.org_id, c.phone_number, min(o.created_at) AS first_at
            FROM opt_outs o
            JOIN contacts c ON c.id = o.contact_id AND c.org_id = o.org_id
            WHERE o.reason = ANY(${REASONS}::text[]) AND o.contact_id = ANY(${ids}::uuid[])
            GROUP BY c.org_id, c.phone_number
          )
          INSERT INTO contact_blocks (org_id, phone_number, reason, source, created_at)
          SELECT org_id, phone_number, 'provider_list', 'opt_outs backfill', first_at FROM src
          ON CONFLICT (org_id, phone_number) WHERE released_at IS NULL DO NOTHING
          RETURNING id`;
        // Mirror every ACTIVE provider_list row onto its contact (D2). Includes
        // rows inserted by an earlier, interrupted run.
        const upd = await tx`
          UPDATE contacts c
          SET blocked_at = b.created_at, block_reason = 'provider_list', updated_at = now()
          FROM contact_blocks b
          WHERE c.id = ANY(${ids}::uuid[])
            AND b.org_id = c.org_id AND b.phone_number = c.phone_number
            AND b.released_at IS NULL AND b.reason = 'provider_list'
            AND c.blocked_at IS NULL
          RETURNING c.id`;
        return { ins: ins.length, upd: upd.length };
      });
      inserted += r.ins;
      updated += r.upd;
      batches++;
      console.log(`batch ${batches}: ${ids.length} contacts → +${r.ins} ledger rows, ${r.upd} contacts blocked`);
    }

    const after = await hot();
    const verify = ((await pg`
      SELECT
        (SELECT count(*) FROM contact_blocks
          WHERE source = 'opt_outs backfill' AND released_at IS NULL)::int AS ledger_rows,
        (SELECT count(*) FROM contacts WHERE block_reason = 'provider_list')::int AS contacts_blocked,
        (SELECT count(*) FROM contacts c
          WHERE c.blocked_at IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM contact_blocks b
            WHERE b.org_id = c.org_id AND b.phone_number = c.phone_number
              AND b.released_at IS NULL AND b.reason <> 'deleted'))::int AS invariant_violations`) as unknown as
      Record<string, number>[])[0];
    console.log(`\ndone: ${batches} batches, +${inserted} ledger rows, ${updated} contacts blocked`);
    console.log(`verify: ${JSON.stringify(verify)}`);
    console.log(`contacts HOT after: ${after.hot}/${after.upd} updates (${after.pct}%), dead ${after.dead}`);
    console.log(`  this run: +${Number(after.upd) - Number(before.upd)} updates, +${Number(after.hot) - Number(before.hot)} HOT (stats may lag — re-read with --hot in a few minutes)`);
    if (verify.invariant_violations !== 0) process.exitCode = 1;
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
