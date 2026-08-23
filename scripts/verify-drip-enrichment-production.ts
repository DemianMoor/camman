import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

// Production proof for the Drip Phase 3 enrichment sweeper.
//
// ⭐ WHY PRODUCTION. The three claims are properties of the DEPLOYED pipeline —
// a landline discarded only on preview says nothing about what production does
// with a real partner's lead.
//
// ⭐ HOW IT AVOIDS TOUCHING ANYTHING REAL. Every number is synthetic (+1999…)
// and its phone_lookups cache row is SEEDED BY THIS SCRIPT, so:
//   * no Telnyx call is made and no balance is spent (the balance is $2.47);
//   * no real person's contact or attributes are ever read or written, which
//     the standing rule requires — a live entity is never a test fixture.
// The work is driven by POSTing the DEPLOYED cron route with CRON_SECRET, so
// this exercises the shipped code path rather than a local copy of it.
//
// Everything created is deleted BY ID at the end and residue is re-checked.

const PROD = "https://camman.vercel.app";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function one<T>(s: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(s)) as unknown as T[])[0];
}

async function main() {
  if (process.env.DRIP_PROD_PROBE !== "yes") {
    console.error(
      "REFUSING to run. This probe writes to PRODUCTION (synthetic partner keys, " +
        "leads, contacts and cache rows, all deleted by id at the end). " +
        "Re-run with DRIP_PROD_PROBE=yes if that is what you intend.",
    );
    process.exit(1);
  }
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) throw new Error("CRON_SECRET is required to drive the deployed cron");

  const sfx = String(Date.now()).slice(-7);
  const phoneMobile = `+1999100${sfx.slice(-4)}`;
  const phoneLandline = `+1999200${sfx.slice(-4)}`;
  const phoneSandbox = `+1999300${sfx.slice(-4)}`;

  const org = await one<{ id: string }>(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`);
  const orgId = org.id;
  console.log(`org ${orgId}`);

  // ── seed: two partner keys and two CACHE rows (no Telnyx call) ──────────
  const liveKey = await one<{ id: number }>(sql`
    INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash, sandbox)
    VALUES (${orgId}, ${"zz-p3-live-" + sfx}, 'P3 probe (live)', ${"tokp3l" + sfx}, 'h', false)
    RETURNING id`);
  const sandboxKey = await one<{ id: number }>(sql`
    INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash, sandbox)
    VALUES (${orgId}, ${"zz-p3-sbx-" + sfx}, 'P3 probe (sandbox)', ${"tokp3s" + sfx}, 'h', true)
    RETURNING id`);

  // The cache hits. This is what makes the run free — enqueueNormalized sees
  // lookup_status='complete' and never queues a Telnyx call.
  for (const [phone, lineType] of [[phoneMobile, "mobile"], [phoneLandline, "landline"]] as const) {
    await db.execute(sql`
      INSERT INTO phone_lookups (phone, line_type, source, lookup_status, looked_up_at)
      VALUES (${phone}, ${lineType}, 'telnyx', 'complete', now())
      ON CONFLICT (phone) DO UPDATE SET line_type = EXCLUDED.line_type,
                                        lookup_status = 'complete'`);
  }
  console.log(`seeded cache: ${phoneMobile}=mobile, ${phoneLandline}=landline (no Telnyx call)`);

  const mkLead = async (keyId: number, slug: string, phone: string, sandbox: boolean, raw: object) =>
    (
      await one<{ id: string }>(sql`
        INSERT INTO lead_inbox (org_id, partner_key_id, partner_slug, raw, phone_e164,
                                interest_tag, sandbox, status, dedup_key)
        VALUES (${orgId}, ${keyId}, ${slug}, ${JSON.stringify(raw)}::jsonb, ${phone},
                'ACA', ${sandbox}, 'received', ${phone + ":" + sfx})
        RETURNING id`)
    ).id;

  const leadReal = await mkLead(liveKey.id, "zz-p3-live-" + sfx, phoneMobile, false, {
    phone: phoneMobile, first_name: "Ada", last_name: "Probe", email: "  ADA@Example.COM ",
    // 1970-01-01 must normalize to NULL, not a 56-year-old cohort.
    dob: "1970-01-01", income: "50-75k", gender: "Female", kids: "yes", zip_code: "94612",
  });
  const leadLandline = await mkLead(liveKey.id, "zz-p3-live-" + sfx, phoneLandline, false, {
    phone: phoneLandline, first_name: "Landline",
  });
  const leadSandbox = await mkLead(sandboxKey.id, "zz-p3-sbx-" + sfx, phoneSandbox, true, {
    phone: phoneSandbox, first_name: "Sandy",
  });

  // ── drive the DEPLOYED cron ─────────────────────────────────────────────
  console.log("\ndriving the deployed sweeper:");
  const res = await fetch(`${PROD}/api/cron/lead-enrichment`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cronSecret}` },
  });
  const body = (await res.json()) as Record<string, unknown>;
  check("cron route returns 200", res.status, 200);
  console.log(`        ${JSON.stringify(body)}`);

  try {
    // ── 1. sandbox lead: full pipeline, no Telnyx, sandbox group only ─────
    console.log("\n1. SANDBOX lead — full pipeline except Telnyx and except the real group:");
    const sbx = await one<{
      status: string; normalized: string | null; contact_id: string | null;
      group_name: string | null; ev_sandbox: boolean | null;
    }>(sql`
      SELECT li.status, li.normalized::text AS normalized,
             c.id AS contact_id, cg.name AS group_name, le.sandbox AS ev_sandbox
      FROM lead_inbox li
      LEFT JOIN contacts c ON c.org_id = li.org_id AND c.phone_number = li.phone_e164
      LEFT JOIN lead_events le ON le.inbox_id = li.id
      LEFT JOIN contact_contact_groups ccg ON ccg.contact_id = c.id
      LEFT JOIN contact_groups cg ON cg.id = ccg.contact_group_id
      WHERE li.id = ${leadSandbox}`);
    check("sandbox lead processed", sbx?.status, "processed");
    check("sandbox contact WAS created", !!sbx?.contact_id, true);
    check("⭐ sandbox contact is in the SANDBOX group, not the real one", sbx?.group_name, "Drip sandbox");
    check("lead event flagged sandbox", sbx?.ev_sandbox, true);

    const sbxCounters = await one<Record<string, number>>(sql`
      SELECT received, mobile, landline, sandbox FROM lead_intake_daily
      WHERE partner_key_id = ${sandboxKey.id}`);
    check("⭐ sandbox counted ONLY as sandbox", sbxCounters?.sandbox, 1);
    check("sandbox did NOT increment received", sbxCounters?.received, 0);
    check("sandbox did NOT increment mobile", sbxCounters?.mobile, 0);

    // ── 2. real lead on a cache-hit number ───────────────────────────────
    console.log("\n2. REAL lead on a cache-hit number — no Telnyx spend:");
    const real = await one<{
      status: string; contact_id: string | null; group_name: string | null;
      first_name: string | null; email: string | null; dob: string | null;
      income_band: string | null; gender: string | null; kids: boolean | null;
      interest_tag: string | null; source: string | null; line_type: string | null;
      raw_has_zip: boolean;
    }>(sql`
      SELECT li.status, c.id AS contact_id, cg.name AS group_name,
             ca.first_name, ca.email, ca.dob::text AS dob, ca.income_band, ca.gender, ca.kids,
             ca.interest_tag, ca.source, le.line_type,
             (li.raw ? 'zip_code') AS raw_has_zip
      FROM lead_inbox li
      LEFT JOIN contacts c ON c.org_id = li.org_id AND c.phone_number = li.phone_e164
      LEFT JOIN contact_attributes ca ON ca.contact_id = c.id
      LEFT JOIN lead_events le ON le.inbox_id = li.id
      LEFT JOIN contact_contact_groups ccg ON ccg.contact_id = c.id
      LEFT JOIN contact_groups cg ON cg.id = ccg.contact_group_id
      WHERE li.id = ${leadReal}`);
    check("real lead processed", real?.status, "processed");
    check("contact created", !!real?.contact_id, true);
    check("in the REAL drip group", real?.group_name, "Drip intake");
    check("attributes written", real?.first_name, "Ada");
    check("email normalized (lowercased + trimmed)", real?.email, "ada@example.com");
    check("⭐ 1970-01-01 dob normalized to NULL, not a fake cohort", real?.dob, null);
    // ⚠️ The partner SENDS "50-75k" (the value the generated partner doc
    // advertises); the column STORES the coded "50k_75k". That asymmetry is the
    // 1c convention — codes so labels can be reworded without a data migration —
    // and the alias map in normalizeIncomeBand is the bridge. Asserting the
    // stored CODE pins both halves; asserting the display label here would
    // invite someone to "fix" the code to match a label.
    check("income input '50-75k' mapped to the stored code", real?.income_band, "50k_75k");
    check("gender canonicalized", real?.gender, "female");
    check("kids coerced to boolean", real?.kids, true);
    check("key's interest tag applied", real?.interest_tag, "ACA");
    check("source stamped", real?.source, "drip_intake");
    check("line_type stamped on the event", real?.line_type, "mobile");
    check("unknown field kept in raw (never discarded)", real?.raw_has_zip, true);

    const liveCounters = await one<Record<string, number>>(sql`
      SELECT received, mobile, landline, sandbox, lookups_spent FROM lead_intake_daily
      WHERE partner_key_id = ${liveKey.id}`);
    check("received counts BOTH real leads", liveCounters?.received, 2);
    check("mobile counted", liveCounters?.mobile, 1);
    check("⭐ lookups_spent is 0 — the cache hit cost nothing", liveCounters?.lookups_spent, 0);

    const queued = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM lookup_queue
      WHERE phone IN (${phoneMobile}, ${phoneLandline})`);
    check("⭐ nothing was enqueued to Telnyx at all", queued?.n, 0);

    // ── 3. forced landline: NO contact, counter increments, row removed ───
    console.log("\n3. FORCED LANDLINE — contact NOT created, counter increments:");
    const llInbox = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM lead_inbox WHERE id = ${leadLandline}`);
    check("⭐ landline lead REMOVED from lead_inbox", llInbox?.n, 0);
    const llContact = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM contacts
      WHERE org_id = ${orgId} AND phone_number = ${phoneLandline}`);
    check("⭐ NO contact was created for the landline", llContact?.n, 0);
    check("⭐ landline counter incremented", liveCounters?.landline, 1);
    const llEvent = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM lead_events
      WHERE partner_key_id = ${liveKey.id} AND line_type = 'landline'`);
    check("no lead event for the landline (it never became a contact)", llEvent?.n, 0);

    // ── idempotency: a second run must change nothing ────────────────────
    console.log("\nidempotency — a second sweeper run is a no-op:");
    const before = await one<{ ev: number; ct: number }>(sql`
      SELECT (SELECT count(*)::int FROM lead_events WHERE partner_key_id IN (${liveKey.id}, ${sandboxKey.id})) AS ev,
             (SELECT count(*)::int FROM contacts WHERE phone_number IN (${phoneMobile}, ${phoneSandbox})) AS ct`);
    await fetch(`${PROD}/api/cron/lead-enrichment`, {
      method: "POST", headers: { Authorization: `Bearer ${cronSecret}` },
    });
    const after = await one<{ ev: number; ct: number }>(sql`
      SELECT (SELECT count(*)::int FROM lead_events WHERE partner_key_id IN (${liveKey.id}, ${sandboxKey.id})) AS ev,
             (SELECT count(*)::int FROM contacts WHERE phone_number IN (${phoneMobile}, ${phoneSandbox})) AS ct`);
    check("no duplicate lead events", after.ev, before.ev);
    check("no duplicate contacts", after.ct, before.ct);

    // ── the monitors route runs and reports ──────────────────────────────
    console.log("\nmonitors (the separate watching job):");
    const mres = await fetch(`${PROD}/api/cron/drip-monitors`, {
      method: "POST", headers: { Authorization: `Bearer ${cronSecret}` },
    });
    const mbody = (await mres.json()) as Record<string, unknown>;
    check("drip-monitors returns 200", mres.status, 200);
    console.log(`        ${JSON.stringify(mbody).slice(0, 400)}`);
    check("balance alert IS firing at $2.47 against a $50 floor", mbody.balanceFiring, true);
  } finally {
    // ── cleanup BY ID ─────────────────────────────────────────────────────
    console.log("\ncleanup (by id):");
    await db.execute(sql`DELETE FROM lead_events WHERE partner_key_id IN (${liveKey.id}, ${sandboxKey.id})`);
    await db.execute(sql`DELETE FROM lead_intake_daily WHERE partner_key_id IN (${liveKey.id}, ${sandboxKey.id})`);
    await db.execute(sql`DELETE FROM lead_inbox WHERE partner_key_id IN (${liveKey.id}, ${sandboxKey.id})`);
    await db.execute(sql`DELETE FROM partner_key_usage WHERE partner_key_id IN (${liveKey.id}, ${sandboxKey.id})`);
    await db.execute(sql`DELETE FROM partner_keys WHERE id IN (${liveKey.id}, ${sandboxKey.id})`);
    const ct = (await db.execute(sql`
      DELETE FROM contacts WHERE org_id = ${orgId}
        AND phone_number IN (${phoneMobile}, ${phoneLandline}, ${phoneSandbox})
      RETURNING id`)) as unknown as { id: string }[];
    await db.execute(sql`DELETE FROM phone_lookups WHERE phone IN (${phoneMobile}, ${phoneLandline}, ${phoneSandbox})`);
    console.log(`        deleted ${ct.length} probe contact(s), 2 keys, seeded cache rows`);

    const residue = await one<Record<string, number>>(sql`
      SELECT (SELECT count(*)::int FROM lead_inbox)        AS inbox,
             (SELECT count(*)::int FROM lead_events)       AS events,
             (SELECT count(*)::int FROM lead_intake_daily) AS daily,
             (SELECT count(*)::int FROM partner_keys)      AS keys,
             (SELECT count(*)::int FROM contacts
               WHERE phone_number LIKE '+1999%')           AS synthetic_contacts`);
    console.log(`        production now: ${JSON.stringify(residue)}`);
    check("no probe leads left", residue.inbox, 0);
    check("no probe events left", residue.events, 0);
    check("no probe counters left", residue.daily, 0);
    check("no probe keys left", residue.keys, 0);
    check("no synthetic contacts left", residue.synthetic_contacts, 0);
  }

  await pgConn.end({ timeout: 5 });
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
