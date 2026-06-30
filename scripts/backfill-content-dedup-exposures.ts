// One-shot backfill: populate the content-dedup ledgers (migration 0086) from
// historical sends. For every stage_sends row that reached status='sent', record
// the creative (resolved via the stage) and the offer (resolved via the campaign)
// into creative_exposures / offer_exposures, dated to the EARLIEST send per
// (contact, creative) / (contact, offer) so "first campaign" is historically
// correct. offer_exposure_counts is maintained by the AFTER INSERT trigger.
//
// Idempotent + re-runnable: both inserts are ON CONFLICT DO NOTHING, so a second
// run is a no-op (already-present pairs are skipped). DISTINCT ON (… ORDER BY
// first_sent_at ASC) makes the earliest send win the campaign_id on the first run.
//
// Scale/perf notes (real data: ~315K sent rows, ~312K creative pairs, ~127K offer
// pairs):
//   * DATABASE_URL is the Supabase TRANSACTION POOLER (port 6543): each autocommit
//     statement may land on a DIFFERENT backend, so session state (TEMP tables,
//     `SET`) does NOT survive across statements. We therefore stage the deduped
//     offer set in a REGULAR table (`_bf_offer_exp`, visible to every backend),
//     batch-insert from it, then drop it — no reliance on session state.
//   * creative_exposures has no trigger → one INSERT…SELECT finishes under the
//     default statement_timeout (proven: it succeeded on the first run).
//   * offer_exposures fires the per-row counter trigger, so we insert in BATCHES.
//     Short statements = no timeout + locks on offer_exposure_counts release every
//     batch (don't stall concurrent live sends). The trigger stays ENABLED, so
//     counts are exact under concurrency: a (contact, offer) a live send already
//     recorded conflicts here (DO NOTHING) and the trigger doesn't fire for it →
//     never double-counted.
//
// Run: `npx tsx scripts/backfill-content-dedup-exposures.ts` against the same
// DATABASE_URL the deployed app uses, AFTER migration 0086 is applied. Bypasses
// RLS via the privileged DB connection — does NOT require a signed-in user.
//
// Blind spot (by design): pure external-CSV campaigns create no stage_sends rows
// and so leave no exposure trace. Nothing more is reconstructable.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const OFFER_BATCH = 5000;

function rowCount(res: unknown): number {
  return Array.isArray(res) ? res.length : 0;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set in .env.local");
    process.exit(1);
  }

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    // ── creative_exposures: one statement, no trigger. Earliest send per
    // (org, contact, creative). Skips rows whose creative was deleted.
    const creativeRes = await db.execute(drizzleSql`
      INSERT INTO public.creative_exposures
        (org_id, contact_id, creative_id, campaign_id, first_sent_at)
      SELECT DISTINCT ON (ss.org_id, ss.contact_id, cs.creative_id)
        ss.org_id, ss.contact_id, cs.creative_id, ss.campaign_id,
        COALESCE(ss.sent_at, ss.created_at) AS first_sent_at
      FROM public.stage_sends ss
      JOIN public.campaign_stages cs ON cs.id = ss.stage_id
      WHERE ss.status = 'sent'
        AND cs.creative_id IS NOT NULL
      ORDER BY ss.org_id, ss.contact_id, cs.creative_id,
               COALESCE(ss.sent_at, ss.created_at) ASC
      ON CONFLICT (org_id, contact_id, creative_id) DO NOTHING
      RETURNING 1
    `);
    const creativeInserted = rowCount(creativeRes);

    // ── offer_exposures: stage the deduped set in a REGULAR table (survives the
    // transaction pooler's per-statement backend switching), number the rows,
    // then insert in batches (trigger fires per row → keep each statement small).
    await db.execute(drizzleSql`DROP TABLE IF EXISTS public._bf_offer_exp`);
    await db.execute(drizzleSql`
      CREATE TABLE public._bf_offer_exp AS
      WITH deduped AS (
        SELECT DISTINCT ON (ss.org_id, ss.contact_id, c.offer_id)
          ss.org_id, ss.contact_id, c.offer_id, ss.campaign_id,
          COALESCE(ss.sent_at, ss.created_at) AS first_sent_at
        FROM public.stage_sends ss
        JOIN public.campaigns c ON c.id = ss.campaign_id
        WHERE ss.status = 'sent'
          AND c.offer_id IS NOT NULL
        ORDER BY ss.org_id, ss.contact_id, c.offer_id,
                 COALESCE(ss.sent_at, ss.created_at) ASC
      )
      SELECT row_number() OVER () AS rn, * FROM deduped
    `);
    const maxRows = (await db.execute(
      drizzleSql`SELECT COALESCE(MAX(rn), 0)::bigint AS n FROM public._bf_offer_exp`,
    )) as unknown as { n: number | string }[];
    const total = Number(maxRows[0]?.n ?? 0);

    let offerInserted = 0;
    for (let lo = 0; lo < total; lo += OFFER_BATCH) {
      const res = await db.execute(drizzleSql`
        INSERT INTO public.offer_exposures
          (org_id, contact_id, offer_id, campaign_id, first_sent_at)
        SELECT org_id, contact_id, offer_id, campaign_id, first_sent_at
        FROM public._bf_offer_exp
        WHERE rn > ${lo} AND rn <= ${lo + OFFER_BATCH}
        ON CONFLICT (org_id, contact_id, offer_id) DO NOTHING
        RETURNING 1
      `);
      offerInserted += rowCount(res);
      process.stdout.write(
        `\r  offer_exposures: ${Math.min(lo + OFFER_BATCH, total)}/${total} processed, ${offerInserted} inserted`,
      );
    }
    process.stdout.write("\n");
    await db.execute(drizzleSql`DROP TABLE IF EXISTS public._bf_offer_exp`);

    // ── Report: final ledger state + a sanity figure on the heaviest offers.
    const totals = (await db.execute(drizzleSql`
      SELECT
        (SELECT count(*) FROM public.creative_exposures)::bigint AS creative_exposures,
        (SELECT count(*) FROM public.offer_exposures)::bigint AS offer_exposures,
        (SELECT count(*) FROM public.offer_exposure_counts)::bigint AS offer_exposure_count_rows,
        (SELECT COALESCE(SUM(distinct_contacts), 0) FROM public.offer_exposure_counts)::bigint AS counter_sum
    `)) as unknown as {
      creative_exposures: string;
      offer_exposures: string;
      offer_exposure_count_rows: string;
      counter_sum: string;
    }[];
    const t = totals[0];

    const top = (await db.execute(drizzleSql`
      SELECT oec.offer_id, o.offer_id AS offer_code, o.name, oec.distinct_contacts
      FROM public.offer_exposure_counts oec
      LEFT JOIN public.offers o ON o.id = oec.offer_id
      ORDER BY oec.distinct_contacts DESC
      LIMIT 5
    `)) as unknown as {
      offer_id: number;
      offer_code: string | null;
      name: string | null;
      distinct_contacts: number | string;
    }[];

    console.log("\n=== Content-dedup backfill summary ===");
    console.log(`Inserted this run — creative_exposures: ${creativeInserted}, offer_exposures: ${offerInserted}`);
    console.log("\nFinal ledger totals:");
    console.log(`  creative_exposures rows:      ${t?.creative_exposures}`);
    console.log(`  offer_exposures rows:         ${t?.offer_exposures}`);
    console.log(`  offer_exposure_counts rows:   ${t?.offer_exposure_count_rows}`);
    console.log(`  SUM(distinct_contacts):       ${t?.counter_sum}  (should equal offer_exposures rows)`);
    const ok = String(t?.counter_sum) === String(t?.offer_exposures);
    console.log(`  counter ↔ ledger agree:       ${ok ? "YES ✓" : "NO ✗ — investigate"}`);
    console.log("\nTop 5 offers by distinct leads used (offer_exposure_counts):");
    for (const r of top) {
      console.log(
        `  offer #${r.offer_id} (${r.offer_code ?? "?"}) ${r.name ?? ""} — ${r.distinct_contacts}`,
      );
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
