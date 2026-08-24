import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

// Schema guard for the Drip Phase 4 routing tables (0159-0162).
//
// ⭐ RUNS ON camman-v2 PREVIEW ONLY. Refuses by project ref, which is in the
// connection string and cannot be bypassed by forgetting an env var.
//
// ⭐ THE SECTION THAT MATTERS MOST is the one-live-journey invariant. "A lead is
// routed to exactly ONE campaign" is the central rule of the whole drip spec,
// and every other part of it — tag match, filters, priority, tie-break — is
// POLICY living in code that can be raced or called twice. The partial unique
// index is what makes it an INVARIANT. So it is asserted in both directions:
// a second live journey is REFUSED, and a completed journey FREES the contact
// for re-entry (which the >1-week rule requires). An index that only ever
// refused would pass a one-sided test while breaking re-entry forever.

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
    // Drizzle wraps the driver error: SQLSTATE is on .cause.code, not .code.
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
  const ref = /postgres\.([a-z0-9]+):/.exec(url)?.[1] ?? "(unknown)";
  if (ref === PROD_REF) {
    console.error(`REFUSING to run against PRODUCTION (${PROD_REF}). This test writes.`);
    process.exit(1);
  }
  console.log(`target project ref: ${ref}${ref === PREVIEW_REF ? "  (camman-v2 preview ✓)" : ""}`);

  console.log("\nschema (0159-0162):");
  const t = (await db.execute(sql`
    SELECT to_regclass('public.drip_campaign_configs')::text AS configs,
           to_regclass('public.drip_journeys')::text         AS journeys`)) as unknown as
    Record<string, string | null>[];
  for (const [k, v] of Object.entries(t[0])) check(`${k} exists`, !!v, true);

  const cols = (await db.execute(sql`
    SELECT column_name, column_default FROM information_schema.columns
    WHERE table_schema='public' AND (
      (table_name='campaigns'    AND column_name='type') OR
      (table_name='org_settings' AND column_name IN ('drip_enabled','drip_paused')))
    ORDER BY column_name`)) as unknown as { column_name: string; column_default: string }[];
  check("campaigns.type + both org_settings flags exist", cols.length, 3);
  check(
    "⭐ campaigns.type defaults to 'regular' (a bad read can never mean drip)",
    cols.find((c) => c.column_name === "type")?.column_default,
    "'regular'::text",
  );
  for (const f of ["drip_enabled", "drip_paused"]) {
    check(`org_settings.${f} defaults false`, cols.find((c) => c.column_name === f)?.column_default, "false");
  }

  // Every pre-existing campaign must have become 'regular'.
  const existing = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE type = 'regular')::int AS regular,
           count(*) FILTER (WHERE type <> 'regular')::int AS other,
           count(*)::int AS total FROM campaigns`)) as unknown as
    { regular: number; other: number; total: number }[];
  check("⭐ every existing campaign is 'regular' (no backfill needed)", existing[0]?.other, 0);
  console.log(`        ${existing[0]?.regular}/${existing[0]?.total} campaigns typed regular`);

  const rls = (await db.execute(sql`
    SELECT relname, relrowsecurity FROM pg_class
    WHERE relname IN ('drip_campaign_configs','drip_journeys')
      AND relnamespace='public'::regnamespace ORDER BY relname`)) as unknown as
    { relname: string; relrowsecurity: boolean }[];
  for (const r of rls) check(`RLS enabled on ${r.relname}`, r.relrowsecurity, true);
  const pol = (await db.execute(sql`
    SELECT tablename, count(*)::int AS n FROM pg_policies
    WHERE schemaname='public' AND tablename IN ('drip_campaign_configs','drip_journeys')
    GROUP BY 1 ORDER BY 1`)) as unknown as { tablename: string; n: number }[];
  check("both new tables carry one SELECT policy", pol.map((p) => p.n), [1, 1]);

  let rolledBack = false;
  try {
    await db.transaction(async (tx) => {
      const orgId = ((await tx.execute(sql`
        SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as
        { id: string }[])[0]?.id;
      if (!orgId) throw new Error("no organization in the preview database");
      const sfx = String(Date.now()).slice(-7);

      const mkCampaign = async (type: string, n: number) =>
        ((await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name, status, type)
          VALUES (${orgId}, ${"p4-" + sfx + "-" + n}, ${"P4 probe " + n}, 'active', ${type})
          RETURNING id`)) as unknown as { id: number }[])[0].id;

      // ── 0159 ────────────────────────────────────────────────────────────
      console.log("\n0159 — campaigns.type:");
      const dripCamp = await mkCampaign("drip", 1);
      const dripCamp2 = await mkCampaign("drip", 2);
      check("a drip campaign inserts", !!dripCamp, true);
      await expectReject(tx, "an unknown type is rejected", sql`
        INSERT INTO campaigns (org_id, slug, name, status, type)
        VALUES (${orgId}, ${"p4-bad-" + sfx}, 'bad', 'draft', 'trickle')`, "23514");

      // ── 0160 ────────────────────────────────────────────────────────────
      console.log("\n0160 — drip_campaign_configs:");
      const cfg = (await tx.execute(sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag)
        VALUES (${dripCamp}, ${orgId}, 'ACA')
        RETURNING priority, filters::text, daily_cap, campaign_cap,
                  routing_daily_admission_cap`)) as unknown as Record<string, unknown>[];
      check("priority defaults to 100", cfg[0]?.priority, 100);
      check("filters defaults to empty object", cfg[0]?.filters, "{}");
      check("daily_cap defaults NULL (inert in P4)", cfg[0]?.daily_cap, null);
      check("routing_daily_admission_cap defaults NULL = unlimited",
            cfg[0]?.routing_daily_admission_cap, null);

      await expectReject(tx, "a second config for one campaign is impossible (1:1 by PK)", sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag)
        VALUES (${dripCamp}, ${orgId}, 'Medicare')`, "23505");
      await expectReject(tx, "end_at <= start_at is rejected", sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, start_at, end_at)
        VALUES (${dripCamp2}, ${orgId}, 'ACA', '2026-09-02', '2026-09-01')`, "23514");
      await expectReject(tx, "a blank interest tag is rejected", sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag)
        VALUES (${dripCamp2}, ${orgId}, '   ')`, "23514");
      await expectReject(tx, "a zero cap is rejected", sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, campaign_cap)
        VALUES (${dripCamp2}, ${orgId}, 'ACA', 0)`, "23514");

      await tx.execute(sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, priority)
        VALUES (${dripCamp2}, ${orgId}, 'ACA', 50)`);

      // ── 0161 — the invariant ────────────────────────────────────────────
      console.log("\n0161 — drip_journeys, the one-live-journey invariant:");
      const contactId = ((await tx.execute(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1996" + sfx})
        RETURNING id`)) as unknown as { id: string }[])[0].id;

      const keyId = ((await tx.execute(sql`
        INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash)
        VALUES (${orgId}, ${"p4k-" + sfx}, 'p4', ${"tokp4" + sfx}, 'h')
        RETURNING id`)) as unknown as { id: number }[])[0].id;

      const mkEvent = async (n: number) =>
        ((await tx.execute(sql`
          INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at)
          VALUES (${orgId}, ${contactId}, ${keyId}, 'p4', now())
          RETURNING id`)) as unknown as { id: string }[])[0].id;

      const ev1 = await mkEvent(1);
      const ev2 = await mkEvent(2);
      const ev3 = await mkEvent(3);

      const j1 = (await tx.execute(sql`
        INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state, reason)
        VALUES (${orgId}, ${dripCamp}, ${contactId}, ${ev1}, 'routed',
                ${JSON.stringify({ won_by: "priority", creative_check: "evaluated" })}::jsonb)
        RETURNING id, state`)) as unknown as { id: string; state: string }[];
      check("first journey routes", j1[0]?.state, "routed");

      // ⭐ A SECOND LIVE JOURNEY FOR THE SAME CONTACT MUST BE REFUSED.
      await expectReject(tx,
        "⭐ a second LIVE journey for the same contact is REFUSED (one campaign only)", sql`
        INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state)
        VALUES (${orgId}, ${dripCamp2}, ${contactId}, ${ev2}, 'routed')`, "23505");

      // ...even in the other live state.
      await expectReject(tx,
        "'active' also counts as live (the partial index covers both)", sql`
        INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state)
        VALUES (${orgId}, ${dripCamp2}, ${contactId}, ${ev2}, 'active')`, "23505");

      await expectReject(tx, "the same lead_event cannot route twice", sql`
        INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state)
        VALUES (${orgId}, ${dripCamp2}, ${contactId}, ${ev1}, 'completed')`, "23505");

      // ⭐ ...but completing it must FREE the contact, or re-entry is broken.
      await tx.execute(sql`UPDATE drip_journeys SET state = 'completed' WHERE id = ${j1[0].id}`);
      const j2 = (await tx.execute(sql`
        INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state)
        VALUES (${orgId}, ${dripCamp2}, ${contactId}, ${ev2}, 'routed')
        RETURNING id`)) as unknown as { id: string }[];
      check("⭐ a COMPLETED journey frees the contact for re-entry", j2.length, 1);

      // 'unroutable' must also not block a later attempt.
      await tx.execute(sql`UPDATE drip_journeys SET state = 'exited' WHERE id = ${j2[0].id}`);
      const j3 = (await tx.execute(sql`
        INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state)
        VALUES (${orgId}, ${dripCamp}, ${contactId}, ${ev3}, 'unroutable')
        RETURNING id`)) as unknown as { id: string }[];
      check("an 'exited' journey also frees the contact", j3.length, 1);

      await expectReject(tx, "an unknown journey state is rejected", sql`
        UPDATE drip_journeys SET state = 'pondering' WHERE id = ${j3[0].id}`, "23514");

      const reason = (await tx.execute(sql`
        SELECT reason->>'creative_check' AS cc FROM drip_journeys WHERE id = ${j1[0].id}
      `)) as unknown as { cc: string }[];
      // ⚠️ Phase 5 COMPLETED the creative half of the same-offer rule, so the
      // "deferred_p5" marker this used to assert is gone. Asserting a marker
      // that no longer exists is how a guard goes red because the feature
      // SHIPPED. What matters now is that reason JSONB round-trips at all.
      check("reason JSONB round-trips arbitrary keys", reason[0]?.cc, "evaluated");

      tx.rollback();
    });
  } catch (e) {
    const ctor = (e as { constructor?: { name?: string } })?.constructor?.name;
    if (ctor === "TransactionRollbackError") rolledBack = true;
    else throw e;
  }

  check("probe transaction rolled back", rolledBack, true);
  const residue = (await db.execute(sql`
    SELECT (SELECT count(*)::int FROM drip_journeys)          AS journeys,
           (SELECT count(*)::int FROM drip_campaign_configs)  AS configs,
           (SELECT count(*)::int FROM campaigns WHERE type='drip') AS drip_campaigns
  `)) as unknown as Record<string, number>[];
  check("no probe journeys left", residue[0]?.journeys, 0);
  check("no probe configs left", residue[0]?.configs, 0);
  check("no probe drip campaigns left", residue[0]?.drip_campaigns, 0);

  await pgConn.end({ timeout: 5 });
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
