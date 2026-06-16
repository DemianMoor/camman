import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// THROWAWAY READ-ONLY DIAGNOSTIC. No writes, no schema change.
// Investigates the "unsubscribed" TextHub rejection class and whether those
// numbers diverge from CamMan's opt_outs suppression list.

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    // 1) Identify the affected campaign(s) by the failure signature.
    const camp = (await db.execute(sql`
      SELECT ss.campaign_id, ss.org_id::text AS org_id,
             count(*)::int AS unsub_failures
      FROM stage_sends ss
      WHERE ss.status = 'failed'
        AND ss.last_error ILIKE '%unsubscribed%'
      GROUP BY ss.campaign_id, ss.org_id
      ORDER BY unsub_failures DESC
    `)) as unknown as { campaign_id: number; org_id: string; unsub_failures: number }[];
    console.log("\n=== 1) Campaigns with 'unsubscribed' failures ===");
    console.table(camp);

    // 2) Distinct last_error variants on failed rows (is 'unsubscribed' its own
    //    bucket vs other failure strings?).
    const variants = (await db.execute(sql`
      SELECT ss.last_error, count(*)::int AS n
      FROM stage_sends ss
      WHERE ss.status = 'failed'
      GROUP BY ss.last_error
      ORDER BY n DESC
    `)) as unknown as { last_error: string | null; n: number }[];
    console.log("\n=== 2) All distinct last_error values among failed sends ===");
    console.table(variants);

    // 3) Verbatim TextHub payloads (send_attempts.raw_body) for a sample of the
    //    unsubscribed rejections — the actual field/value, http status, classification.
    const samples = (await db.execute(sql`
      SELECT sa.http_status, sa.classification, sa.ok, sa.message_id,
             sa.error, sa.raw_body
      FROM send_attempts sa
      JOIN stage_sends ss ON ss.id = sa.stage_send_id
      WHERE ss.status = 'failed'
        AND ss.last_error ILIKE '%unsubscribed%'
      ORDER BY sa.created_at DESC
      LIMIT 5
    `)) as unknown as {
      http_status: number;
      classification: string;
      ok: boolean;
      message_id: string | null;
      error: string | null;
      raw_body: string | null;
    }[];
    console.log("\n=== 3) Verbatim TextHub payloads for unsubscribed rejections (sample of 5) ===");
    for (const s of samples) {
      console.log("-".repeat(70));
      console.log(`  http_status   : ${s.http_status}`);
      console.log(`  classification: ${s.classification}`);
      console.log(`  ok            : ${s.ok}`);
      console.log(`  message_id    : ${s.message_id ?? "(null)"}`);
      console.log(`  error (norm)  : ${s.error ?? "(null)"}`);
      console.log(`  raw_body      : ${s.raw_body ?? "(null)"}`);
    }

    // 3b) Distinct raw_body shapes across ALL unsubscribed rejections (are they
    //     byte-identical, or are there several phrasings?).
    const rawShapes = (await db.execute(sql`
      SELECT sa.http_status, sa.raw_body, count(*)::int AS n
      FROM send_attempts sa
      JOIN stage_sends ss ON ss.id = sa.stage_send_id
      WHERE ss.status = 'failed'
        AND ss.last_error ILIKE '%unsubscribed%'
      GROUP BY sa.http_status, sa.raw_body
      ORDER BY n DESC
    `)) as unknown as { http_status: number; raw_body: string | null; n: number }[];
    console.log("\n=== 3b) Distinct (http_status, raw_body) shapes for unsubscribed rejections ===");
    console.table(rawShapes);

    // 4) Opt-out divergence. For the unsubscribed-failed rows, how many of those
    //    CONTACTS are already in CamMan's opt_outs (same org)? Cross-reference by
    //    contact_id (exact) and report the gap.
    const divergence = (await db.execute(sql`
      WITH failed AS (
        SELECT DISTINCT ss.org_id, ss.contact_id, ss.phone
        FROM stage_sends ss
        WHERE ss.status = 'failed'
          AND ss.last_error ILIKE '%unsubscribed%'
      )
      SELECT
        count(*)::int AS distinct_failed_contacts,
        count(*) FILTER (WHERE oo.contact_id IS NOT NULL)::int AS already_in_opt_outs,
        count(*) FILTER (WHERE oo.contact_id IS NULL)::int     AS NOT_in_opt_outs
      FROM failed f
      LEFT JOIN LATERAL (
        SELECT 1 AS contact_id
        FROM opt_outs oo
        WHERE oo.org_id = f.org_id AND oo.contact_id = f.contact_id
        LIMIT 1
      ) oo ON true
    `)) as unknown as {
      distinct_failed_contacts: number;
      already_in_opt_outs: number;
      not_in_opt_outs: number;
    }[];
    console.log("\n=== 4) Opt-out divergence (by contact_id, exact) ===");
    console.table(divergence);

    // 4b) Also cross-reference by phone string (in case opt_outs lacks the
    //     contact link or phone formats differ from contact_id linkage).
    const divergencePhone = (await db.execute(sql`
      WITH failed AS (
        SELECT DISTINCT ss.org_id, ss.phone
        FROM stage_sends ss
        WHERE ss.status = 'failed'
          AND ss.last_error ILIKE '%unsubscribed%'
      )
      SELECT
        count(*)::int AS distinct_failed_phones,
        count(*) FILTER (WHERE oo.phone_number IS NOT NULL)::int AS phone_in_opt_outs,
        count(*) FILTER (WHERE oo.phone_number IS NULL)::int     AS phone_NOT_in_opt_outs
      FROM failed f
      LEFT JOIN LATERAL (
        SELECT 1 AS phone_number
        FROM opt_outs oo
        WHERE oo.org_id = f.org_id AND oo.phone_number = f.phone
        LIMIT 1
      ) oo ON true
    `)) as unknown as {
      distinct_failed_phones: number;
      phone_in_opt_outs: number;
      phone_not_in_opt_outs: number;
    }[];
    console.log("\n=== 4b) Opt-out divergence (by phone string, exact) ===");
    console.table(divergencePhone);

    // 5) Of the ones already in opt_outs, what source/reason are they? (tells us
    //    whether they came from our own STOP-polling intake or elsewhere, and
    //    whether they pre-date the campaign send.)
    const sources = (await db.execute(sql`
      WITH failed AS (
        SELECT DISTINCT ss.org_id, ss.contact_id
        FROM stage_sends ss
        WHERE ss.status = 'failed'
          AND ss.last_error ILIKE '%unsubscribed%'
      )
      SELECT oo.source, oo.reason, count(*)::int AS n
      FROM failed f
      JOIN opt_outs oo ON oo.org_id = f.org_id AND oo.contact_id = f.contact_id
      GROUP BY oo.source, oo.reason
      ORDER BY n DESC
    `)) as unknown as { source: string | null; reason: string; n: number }[];
    console.log("\n=== 5) opt_outs source/reason for already-suppressed failed contacts ===");
    console.table(sources);
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("probe-unsub-rejections crashed:", err);
  process.exit(1);
});
