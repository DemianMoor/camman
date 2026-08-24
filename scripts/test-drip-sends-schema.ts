import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

// Schema guard for the Drip Phase 5 send tables (0164-0166).
//
// ⭐ THE SECTION THAT MATTERS MOST is the BOTH-STAMPS pin. Phase 5's entire
// claim to leaving the live send path alone rests on one property:
//
//   Phase A  (materialize) selects  materialized_at IS NULL  AND sent_at IS NULL
//   Phase B  (drain)       selects  materialized_at IS NOT NULL
//
// so a drip stage created with BOTH stamped is invisible to Phase A and
// permanently drainable by Phase B. That is what lets kickoff.ts and drain.ts go
// untouched (G1). Nothing in either file says "drip", so nothing in either file
// will fail if that property is broken — a future edit to either predicate would
// silently either double-materialize drip stages or strand them forever.
//
// This test therefore replays BOTH selectors' real predicates against a
// synthesized drip stage and asserts the split directly.
//
// Preview only: it writes.

const PROD_REF = "rtdarhkkjwcetlmruftl";
const PREVIEW_REF = "fdzxzxayhknywvmrhjcj";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function expectReject(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  label: string,
  stmt: ReturnType<typeof sql>,
  expectedCode: string,
) {
  await tx.execute(sql`SAVEPOINT probe`);
  let code = "NO-ERROR";
  let constraint = "";
  try {
    await tx.execute(stmt);
  } catch (e) {
    const cause = (e as { cause?: Record<string, unknown> })?.cause;
    code = String(cause?.code ?? (e as { code?: string })?.code ?? "UNKNOWN");
    constraint = String(cause?.constraint_name ?? "");
  }
  await tx.execute(sql`ROLLBACK TO SAVEPOINT probe`);
  check(label, code, expectedCode);
  if (constraint) console.log(`        via constraint ${constraint}`);
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const ref = /postgres\.([a-z0-9]+):/.exec(url)?.[1] ?? "";
  if (ref === PROD_REF) {
    console.error(`REFUSING to run against PRODUCTION (${PROD_REF}). This test writes.`);
    process.exit(1);
  }
  console.log(`target ref: ${ref}${ref === PREVIEW_REF ? "  (camman-v2 preview ✓)" : ""}`);

  console.log("\nschema (0164-0166):");
  const cols = (await db.execute(sql`
    SELECT table_name, column_name, is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND (
      (table_name='campaign_stages' AND column_name IN ('window_start_min','window_end_min','drip_active')) OR
      (table_name='drip_journeys'   AND column_name IN ('first_stage_id','first_send_at','first_send_id')))
    ORDER BY table_name, column_name
  `)) as unknown as { table_name: string; column_name: string; is_nullable: string }[];
  check("all six new columns exist", cols.length, 6);
  check("⭐ every one is NULLABLE (regular stages unaffected)",
        cols.every((c) => c.is_nullable === "YES"), true);
  const tbl = (await db.execute(sql`
    SELECT to_regclass('public.drip_campaign_numbers')::text AS t`)) as unknown as
    { t: string | null }[];
  check("drip_campaign_numbers exists", !!tbl[0]?.t, true);

  // Every existing stage must still be a regular stage.
  const existing = (await db.execute(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE window_start_min IS NOT NULL)::int AS with_window,
           count(*) FILTER (WHERE drip_active IS NOT NULL)::int AS with_flag
    FROM campaign_stages`)) as unknown as
    { total: number; with_window: number; with_flag: number }[];
  check("⭐ no existing stage gained a window", existing[0]?.with_window, 0);
  check("⭐ no existing stage gained a drip flag", existing[0]?.with_flag, 0);
  console.log(`        (${existing[0]?.total} stages, all still regular)`);

  let rolledBack = false;
  try {
    await db.transaction(async (tx) => {
      const orgRows = (await tx.execute(sql`
        SELECT id FROM organizations ORDER BY created_at LIMIT 1
      `)) as unknown as { id: string }[];
      const orgId = orgRows[0].id;
      const sfx = String(Date.now()).slice(-7);

      const campRows = (await tx.execute(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
        VALUES (${orgId}, ${"p5-" + sfx}, 'P5 probe', 'active', 'drip', 'tracked')
        RETURNING id
      `)) as unknown as { id: number }[];
      const campId = campRows[0].id;

      // ── 0164: window CHECK ──────────────────────────────────────────────
      console.log("\n0164 — drip stage windows:");
      const mkStage = async (
        n: number, start: number | null, end: number | null, active: boolean | null,
        materialized: boolean, sent: boolean,
      ) => {
        const rows = (await tx.execute(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, window_start_min, window_end_min, drip_active,
             send_approved, scheduled_at, materialized_at, sent_at)
          VALUES (${orgId}, ${campId}, ${n}, ${start}, ${end}, ${active},
                  true, now(),
                  ${materialized ? sql`now()` : sql`NULL`},
                  ${sent ? sql`now()` : sql`NULL`})
          RETURNING id
        `)) as unknown as { id: number }[];
        return rows[0].id;
      };

      const dripStage = await mkStage(1, 570, 840, true, true, true); // 09:30-14:00
      check("a drip stage with a valid window inserts", !!dripStage, true);

      await expectReject(tx, "zero-length window ⇒ rejected", sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number,
          window_start_min, window_end_min, drip_active)
        VALUES (${orgId}, ${campId}, 90, 600, 600, true)`, "23514");
      await expectReject(tx, "end before start ⇒ rejected", sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number,
          window_start_min, window_end_min, drip_active)
        VALUES (${orgId}, ${campId}, 91, 800, 600, true)`, "23514");
      await expectReject(tx, "window past the end of the day ⇒ rejected", sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number,
          window_start_min, window_end_min, drip_active)
        VALUES (${orgId}, ${campId}, 92, 100, 1441, true)`, "23514");
      await expectReject(tx, "half a window (start only) ⇒ rejected", sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number,
          window_start_min, window_end_min, drip_active)
        VALUES (${orgId}, ${campId}, 93, 600, NULL, true)`, "23514");

      // The regular shape must still be legal — an additive CHECK that rejects
      // the existing shape is not additive.
      const regular = await mkStage(2, null, null, null, false, false);
      check("⭐ a REGULAR stage (no window at all) still inserts", !!regular, true);

      // ── ⭐ THE BOTH-STAMPS PIN ──────────────────────────────────────────
      console.log("\n⭐ both-stamps: Phase A must NOT see it, Phase B MUST (G1):");
      const phaseASees = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM campaign_stages s
        JOIN campaigns c ON c.id = s.campaign_id
        WHERE s.id = ${dripStage}
          AND c.link_mode = 'tracked' AND c.status = 'active'
          AND (c.send_paused IS NOT TRUE)
          AND s.send_approved = true
          AND s.scheduled_at IS NOT NULL AND s.scheduled_at <= now()
          AND s.sent_at IS NULL
          AND s.archived_at IS NULL
          AND s.materialized_at IS NULL
      `)) as unknown as { n: number }[];
      check("⭐ Phase A (materialize) does NOT select the drip stage", phaseASees[0]?.n, 0);

      const phaseBSees = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM campaign_stages s
        JOIN campaigns c ON c.id = s.campaign_id
        WHERE s.id = ${dripStage}
          AND c.link_mode = 'tracked' AND c.status = 'active'
          AND (c.send_paused IS NOT TRUE)
          AND s.send_approved = true
          AND s.archived_at IS NULL
          AND s.materialized_at IS NOT NULL
          AND (s.sent_at IS NOT NULL OR (s.scheduled_at IS NOT NULL AND s.scheduled_at <= now()))
      `)) as unknown as { n: number }[];
      check("⭐ Phase B (drain) DOES select the drip stage", phaseBSees[0]?.n, 1);

      // Control: a stage stamped NEITHER way is the mirror image. Without this,
      // the pair above would pass on a predicate that always returned 0 and 1.
      const unstamped = await mkStage(3, 900, 1000, true, false, false);
      const ctlA = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM campaign_stages s
        WHERE s.id = ${unstamped} AND s.sent_at IS NULL AND s.materialized_at IS NULL
      `)) as unknown as { n: number }[];
      check("control: an UNstamped stage is Phase-A-shaped", ctlA[0]?.n, 1);
      const ctlB = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM campaign_stages s
        WHERE s.id = ${unstamped} AND s.materialized_at IS NOT NULL
      `)) as unknown as { n: number }[];
      check("control: ...and NOT Phase-B-shaped", ctlB[0]?.n, 0);

      // ── 0165: numbers ───────────────────────────────────────────────────
      console.log("\n0165 — drip_campaign_numbers:");
      const phoneRows = (await tx.execute(sql`
        SELECT id FROM provider_phones LIMIT 1`)) as unknown as { id: number }[];
      if (phoneRows[0]) {
        const rows = (await tx.execute(sql`
          INSERT INTO drip_campaign_numbers (campaign_id, provider_phone_id, org_id, daily_limit)
          VALUES (${campId}, ${phoneRows[0].id}, ${orgId}, 1500)
          RETURNING position, daily_limit
        `)) as unknown as { position: number; daily_limit: number }[];
        check("number selection inserts, position defaults 0", rows[0]?.position, 0);
        check("daily_limit stored", rows[0]?.daily_limit, 1500);
        await expectReject(tx, "the same number twice on one campaign ⇒ rejected", sql`
          INSERT INTO drip_campaign_numbers (campaign_id, provider_phone_id, org_id)
          VALUES (${campId}, ${phoneRows[0].id}, ${orgId})`, "23505");
        await expectReject(tx, "a zero daily limit ⇒ rejected", sql`
          INSERT INTO drip_campaign_numbers (campaign_id, provider_phone_id, org_id, daily_limit)
          SELECT ${campId}, id, ${orgId}, 0 FROM provider_phones
          WHERE id <> ${phoneRows[0].id} LIMIT 1`, "23514");
      } else {
        console.log("  SKIP  no provider_phones in the preview database");
      }

      // ── 0166: first-send bookkeeping ────────────────────────────────────
      console.log("\n0166 — first-send state agreement:");
      const contactRows = (await tx.execute(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1992" + sfx})
        RETURNING id`)) as unknown as { id: string }[];
      const keyRows = (await tx.execute(sql`
        INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash)
        VALUES (${orgId}, ${"p5k-" + sfx}, 'p5', ${"tp5" + sfx}, 'h') RETURNING id
      `)) as unknown as { id: number }[];
      const evRows = (await tx.execute(sql`
        INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at)
        VALUES (${orgId}, ${contactRows[0].id}, ${keyRows[0].id}, 'p5', now()) RETURNING id
      `)) as unknown as { id: string }[];

      const jRows = (await tx.execute(sql`
        INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state)
        VALUES (${orgId}, ${campId}, ${contactRows[0].id}, ${evRows[0].id}, 'routed')
        RETURNING id`)) as unknown as { id: string }[];
      const jId = jRows[0].id;

      await expectReject(tx,
        "⭐ a 'routed' journey may NOT carry a first_send_at (would allow a 2nd first-send)", sql`
        UPDATE drip_journeys SET first_send_at = now() WHERE id = ${jId}`, "23514");

      await tx.execute(sql`
        UPDATE drip_journeys
        SET state = 'active', first_send_at = now(), first_stage_id = ${dripStage}
        WHERE id = ${jId}`);
      const after = (await tx.execute(sql`
        SELECT state, (first_send_at IS NOT NULL) AS sent, first_stage_id
        FROM drip_journeys WHERE id = ${jId}`)) as unknown as
        { state: string; sent: boolean; first_stage_id: number }[];
      check("moving to 'active' WITH a first send is allowed", after[0]?.state, "active");
      check("...and records which stage sent it", after[0]?.first_stage_id, dripStage);

      // The due-scan must no longer see it.
      const due = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM drip_journeys
        WHERE org_id = ${orgId}::uuid AND state = 'routed' AND first_send_at IS NULL
          AND id = ${jId}`)) as unknown as { n: number }[];
      check("⭐ the due-scan no longer returns an already-sent journey", due[0]?.n, 0);

      tx.rollback();
    });
  } catch (e) {
    const ctor = (e as { constructor?: { name?: string } })?.constructor?.name;
    if (ctor === "TransactionRollbackError") rolledBack = true;
    else throw e;
  }

  check("probe rolled back", rolledBack, true);
  const residue = (await db.execute(sql`
    SELECT (SELECT count(*)::int FROM drip_campaign_numbers) AS numbers,
           (SELECT count(*)::int FROM campaign_stages WHERE drip_active IS NOT NULL) AS drip_stages
  `)) as unknown as { numbers: number; drip_stages: number }[];
  check("no probe numbers left", residue[0]?.numbers, 0);
  check("no probe drip stages left", residue[0]?.drip_stages, 0);

  await pgConn.end({ timeout: 5 });
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
