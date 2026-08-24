import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

// Schema + limiter guard for the Drip Phase 2 intake tables (0152-0154).
//
// ⭐ WHERE IT RUNS. This test WRITES, so per docs/07-conventions.md it must run
// against the disposable camman-v2 preview database, NEVER production. It
// refuses by PROJECT REF rather than trusting the operator to point it correctly
// — the ref is in the connection string, so the check cannot be bypassed by
// forgetting an env var. Run it as:
//
//   DATABASE_URL=<camman-v2 transaction-pooler url> npx tsx scripts/test-intake-schema.ts
//
// ⭐ WHAT IT IS REALLY FOR: the limiter. A rate limiter that only ever gets
// tested on its allow path is indistinguishable from no limiter at all, and one
// tested only on its refuse path is indistinguishable from a closed door. Every
// assertion below therefore states which way it must go. The two that matter
// most are that the guarded upsert REFUSES by returning NO ROW, and that a
// refused attempt leaves the counter UNCHANGED — because the naive counter
// shape (the one campaign_tracking_counters uses to allocate sequence numbers)
// passes an allow-path test while silently burning a partner's daily quota on
// every rejected retry.
//
// Everything runs inside ONE transaction that is rolled back, so the preview
// database is left exactly as found.

const PROD_REF = "rtdarhkkjwcetlmruftl";
const PREVIEW_REF = "fdzxzxayhknywvmrhjcj";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Runs a statement expected to violate a constraint; returns the SQLSTATE. */
async function expectReject(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  label: string,
  stmt: ReturnType<typeof sql>,
  expectedCode: string,
) {
  // A failed statement aborts the transaction unless it is wrapped, so each
  // rejection probe gets its own SAVEPOINT.
  await tx.execute(sql`SAVEPOINT probe`);
  let code = "NO-ERROR";
  let constraint = "";
  try {
    await tx.execute(stmt);
  } catch (e) {
    // ⚠️ Drizzle wraps the driver error: the SQLSTATE lives on
    // DrizzleQueryError.cause.code, NOT on the error itself. Reading `.code`
    // directly yields undefined for EVERY rejection — and a laxer assertion
    // (`code !== "NO-ERROR"`) would then have passed while asserting nothing.
    // Hence exact SQLSTATE comparison, and the constraint name printed as
    // corroboration that the RIGHT rule fired, not just some rule.
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
    console.error(
      `REFUSING to run against PRODUCTION (${PROD_REF}). This test writes.\n` +
        `Point DATABASE_URL at the camman-v2 preview database (${PREVIEW_REF}).`,
    );
    process.exit(1);
  }
  console.log(`target project ref: ${ref}${ref === PREVIEW_REF ? "  (camman-v2 preview ✓)" : ""}`);

  // ── the migrations actually landed ────────────────────────────────────────
  console.log("\nschema (migrations 0152-0154):");
  const tables = (await db.execute(sql`
    SELECT to_regclass('public.partner_keys')::text     AS partner_keys,
           to_regclass('public.lead_inbox')::text       AS lead_inbox,
           to_regclass('public.partner_key_usage')::text AS partner_key_usage,
           to_regclass('public.alert_state')::text      AS alert_state
  `)) as unknown as Record<string, string | null>[];
  for (const [k, v] of Object.entries(tables[0])) check(`${k} exists`, !!v, true);

  const rls = (await db.execute(sql`
    SELECT relname, relrowsecurity FROM pg_class
    WHERE relname IN ('partner_keys','lead_inbox','partner_key_usage','alert_state')
      AND relnamespace = 'public'::regnamespace
    ORDER BY relname
  `)) as unknown as { relname: string; relrowsecurity: boolean }[];
  for (const r of rls) check(`RLS enabled on ${r.relname}`, r.relrowsecurity, true);

  // alert_state is infra: RLS on, deliberately NO policies (absent = denial).
  const pol = (await db.execute(sql`
    SELECT tablename, count(*)::int AS n FROM pg_policies
    WHERE schemaname='public'
      AND tablename IN ('partner_keys','lead_inbox','partner_key_usage','alert_state')
    GROUP BY tablename ORDER BY tablename
  `)) as unknown as { tablename: string; n: number }[];
  const polMap = Object.fromEntries(pol.map((p) => [p.tablename, p.n]));
  check("partner_keys has a SELECT policy", polMap["partner_keys"] ?? 0, 1);
  check("lead_inbox has a SELECT policy", polMap["lead_inbox"] ?? 0, 1);
  check("partner_key_usage has a SELECT policy", polMap["partner_key_usage"] ?? 0, 1);
  check("alert_state has NO policies (infra table)", polMap["alert_state"] ?? 0, 0);

  let rolledBack = false;
  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`
        SELECT id FROM organizations ORDER BY created_at LIMIT 1
      `)) as unknown as { id: string }[];
      const orgId = org[0]?.id;
      if (!orgId) throw new Error("no organization in the preview database");

      const mkKey = async (slug: string, extra = sql``) =>
        ((await tx.execute(sql`
          INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash ${extra})
          VALUES (${orgId}, ${slug}, ${"Test " + slug}, ${"tok_" + slug}, ${"h_" + slug} ${extra})
          RETURNING id, sandbox, rate_per_sec, rate_per_day, max_payload_bytes, status`)) as unknown as {
          id: number; sandbox: boolean; rate_per_sec: number; rate_per_day: number;
          max_payload_bytes: number; status: string;
        }[])[0];

      // ── defaults ────────────────────────────────────────────────────────
      console.log("\npartner_keys defaults:");
      const k = await mkKey("probe-a");
      check("sandbox defaults TRUE (a new key cannot do real work)", k.sandbox, true);
      check("rate_per_sec default", k.rate_per_sec, 10);
      check("rate_per_day default", k.rate_per_day, 50000);
      check("max_payload_bytes default (256 KB)", k.max_payload_bytes, 262144);
      check("status default", k.status, "active");

      // ── CHECK constraints actually reject ───────────────────────────────
      console.log("\npartner_keys constraints reject bad values:");
      await expectReject(tx, "interest_tag_mode='force' with NO tag ⇒ rejected", sql`
        INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash, interest_tag_mode)
        VALUES (${orgId},'probe-force','x','tok_force','h','force')`, "23514");
      await expectReject(tx, "unknown interest_tag_mode ⇒ rejected", sql`
        INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash, interest_tag_mode)
        VALUES (${orgId},'probe-bad','x','tok_bad','h','sometimes')`, "23514");
      await expectReject(tx, "rate_per_sec = 0 ⇒ rejected", sql`
        INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash, rate_per_sec)
        VALUES (${orgId},'probe-z','x','tok_z','h',0)`, "23514");
      await expectReject(tx, "max_payload_bytes above Vercel's ~4.5MB ceiling ⇒ rejected", sql`
        INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash, max_payload_bytes)
        VALUES (${orgId},'probe-big','x','tok_big','h',9999999)`, "23514");
      await expectReject(tx, "duplicate token ⇒ rejected (global uniqueness)", sql`
        INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash)
        VALUES (${orgId},'probe-dup','x','tok_probe-a','h')`, "23505");
      await expectReject(tx, "duplicate (org, partner_slug) ⇒ rejected", sql`
        INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash)
        VALUES (${orgId},'probe-a','x','tok_other','h')`, "23505");

      // 'force' WITH a tag must be allowed — the constraint must not be a
      // blanket ban on the mode it exists to make safe.
      const forced = (await tx.execute(sql`
        INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash, interest_tag_mode, interest_tag)
        VALUES (${orgId},'probe-forced','x','tok_forced','h','force','ACA')
        RETURNING interest_tag_mode`)) as unknown as { interest_tag_mode: string }[];
      check("interest_tag_mode='force' WITH a tag ⇒ allowed", forced[0]?.interest_tag_mode, "force");

      // ── lead_inbox dedup semantics ──────────────────────────────────────
      console.log("\nlead_inbox dedup (the G17 ruling):");
      const mkLead = async (dedup: string | null, status = "received") =>
        ((await tx.execute(sql`
          INSERT INTO lead_inbox (org_id, partner_key_id, partner_slug, raw, status, dedup_key)
          VALUES (${orgId}, ${k.id}, 'probe-a', '{"a":1}'::jsonb, ${status}, ${dedup})
          ON CONFLICT (partner_key_id, dedup_key) WHERE dedup_key IS NOT NULL
          DO NOTHING
          RETURNING id`)) as unknown as { id: string }[]);

      const first = await mkLead("k1");
      check("first lead with a dedup key inserts", first.length, 1);
      const dup = await mkLead("k1");
      check("same dedup key collapses (0 rows ⇒ duplicate detected)", dup.length, 0);

      // The whole point of G17: a phone-less lead has NO dedup key and must
      // still be STORED, as 'rejected' with an error, not dropped at the edge.
      const noKey1 = await mkLead(null, "rejected");
      const noKey2 = await mkLead(null, "rejected");
      check("phone-less lead #1 stored (dedup_key NULL)", noKey1.length, 1);
      check("phone-less lead #2 ALSO stored — NULLs do not collide", noKey2.length, 1);

      await expectReject(tx, "unknown status ⇒ rejected", sql`
        INSERT INTO lead_inbox (org_id, partner_key_id, partner_slug, raw, status)
        VALUES (${orgId}, ${k.id}, 'probe-a', '{}'::jsonb, 'weird')`, "23514");

      // ON DELETE RESTRICT: a key with leads behind it must fail loudly.
      await expectReject(tx, "deleting a key that has leads ⇒ RESTRICTed", sql`
        DELETE FROM partner_keys WHERE id = ${k.id}`, "23503");

      // ── THE LIMITER ─────────────────────────────────────────────────────
      console.log("\nrate limiter — the guarded upsert:");
      const bump = async (kind: string, n: number, limit: number, win = "2026-08-22T00:00:00Z") =>
        ((await tx.execute(sql`
          INSERT INTO partner_key_usage (org_id, partner_key_id, window_kind, window_start, count)
          VALUES (${orgId}, ${k.id}, ${kind}, ${win}::timestamptz, ${n})
          ON CONFLICT (partner_key_id, window_kind, window_start)
          DO UPDATE SET count = partner_key_usage.count + ${n}
            WHERE partner_key_usage.count + ${n} <= ${limit}
          RETURNING count`)) as unknown as { count: number }[]);

      const a1 = await bump("sec", 1, 3);
      check("1st request under the limit ⇒ allowed, count 1", a1[0]?.count, 1);
      const a2 = await bump("sec", 1, 3);
      check("2nd ⇒ allowed, count 2", a2[0]?.count, 2);
      const a3 = await bump("sec", 1, 3);
      check("3rd ⇒ allowed, count 3 (at the limit)", a3[0]?.count, 3);

      const refused = await bump("sec", 1, 3);
      check("4th ⇒ REFUSED: no row returned", refused.length, 0);

      const after = (await tx.execute(sql`
        SELECT count FROM partner_key_usage
        WHERE partner_key_id=${k.id} AND window_kind='sec'`)) as unknown as { count: number }[];
      check("⭐ counter UNCHANGED after refusal (a 429 burns no quota)", after[0]?.count, 3);

      // Daily window counts LEADS, not requests (G14) — a batch costs its size.
      const d1 = await bump("day", 500, 1000);
      check("batch of 500 leads ⇒ allowed, daily count 500", d1[0]?.count, 500);
      const d2 = await bump("day", 500, 1000);
      check("second 500 ⇒ allowed, exactly at 1000", d2[0]?.count, 1000);
      const d3 = await bump("day", 1, 1000);
      check("one more lead ⇒ REFUSED", d3.length, 0);

      // ⚠️ The documented hole: the INSERT branch is NOT covered by the WHERE,
      // so a cold window admits an oversized batch. Asserted so the route-level
      // pre-check can never be quietly deleted as redundant.
      const cold = await bump("day", 99999, 10, "2026-08-23T00:00:00Z");
      check(
        "⚠️ cold-window INSERT bypasses the guard (route MUST pre-check batch size)",
        cold[0]?.count,
        99999,
      );

      await expectReject(tx, "unknown window_kind ⇒ rejected", sql`
        INSERT INTO partner_key_usage (org_id, partner_key_id, window_kind, window_start, count)
        VALUES (${orgId}, ${k.id}, 'fortnight', now(), 1)`, "23514");

      // ── alert_state ─────────────────────────────────────────────────────
      // Mirrors the real claim in lib/alerts/alert-state.ts's transitionAlert,
      // not a simplified stand-in: `last_notified_at` is never set by this
      // probe (it stays NULL, the same as a send that hasn't yet been
      // confirmed delivered), so the second disjunct below matches every time
      // and the row is pending, not latched — a bad-secret probe never stamps
      // delivery, only a real send does.
      console.log("\nalert_state transition gating:");
      const trans = (await tx.execute(sql`
        INSERT INTO alert_state (alert_key, org_id, state)
        VALUES ('probe:auth_fail', ${orgId}, 'firing')
        ON CONFLICT (alert_key) DO UPDATE SET state = 'firing'
          WHERE alert_state.state <> 'firing' OR alert_state.last_notified_at IS NULL
        RETURNING alert_key`)) as unknown as { alert_key: string }[];
      check("first transition into firing ⇒ notifies (row returned)", trans.length, 1);
      const again = (await tx.execute(sql`
        INSERT INTO alert_state (alert_key, org_id, state)
        VALUES ('probe:auth_fail', ${orgId}, 'firing')
        ON CONFLICT (alert_key) DO UPDATE SET state = 'firing'
          WHERE alert_state.state <> 'firing' OR alert_state.last_notified_at IS NULL
        RETURNING alert_key`)) as unknown as { alert_key: string }[];
      check(
        "⭐ still firing but PENDING (never stamped delivered) ⇒ RE-CLAIMS (row returned) " +
          "— this is the real gating; see lib/alerts/alert-state.ts",
        again.length,
        1,
      );

      await expectReject(tx, "unknown alert state ⇒ rejected", sql`
        INSERT INTO alert_state (alert_key, state) VALUES ('probe:x','melting')`, "23514");

      tx.rollback();
    });
  } catch (e) {
    const ctor = (e as { constructor?: { name?: string } })?.constructor?.name;
    if (ctor === "TransactionRollbackError") rolledBack = true;
    else throw e;
  }

  check("\nprobe transaction rolled back", rolledBack, true);
  const residue = (await db.execute(sql`
    SELECT (SELECT count(*)::int FROM partner_keys WHERE partner_slug LIKE 'probe-%') AS keys,
           (SELECT count(*)::int FROM lead_inbox WHERE partner_slug = 'probe-a')      AS leads,
           (SELECT count(*)::int FROM alert_state WHERE alert_key LIKE 'probe:%')     AS alerts
  `)) as unknown as { keys: number; leads: number; alerts: number }[];
  check("no probe partner_keys left behind", residue[0]?.keys, 0);
  check("no probe leads left behind", residue[0]?.leads, 0);
  check("no probe alert_state left behind", residue[0]?.alerts, 0);

  await pgConn.end({ timeout: 5 });
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
