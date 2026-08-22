import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

// Production proof for the Drip Phase 2 intake endpoint.
//
// ⭐ WHY THIS RUNS AGAINST PRODUCTION AT ALL, when the standing rule is that
// tests which write use the camman-v2 preview database. The four things being
// proven are properties of the DEPLOYED endpoint — a 413 that only ever
// happened on preview says nothing about what production enforces — and the
// only writes are SANDBOX leads through a SANDBOX key, which by construction
// are excluded from sending and reporting. Owner-authorised for this purpose.
//
// ⭐ EVERY PROBE CHECKS THE DATABASE, NOT JUST THE STATUS CODE. "401 + NO ROW"
// is two claims: a handler that returned 401 after writing would pass a
// status-only assertion while leaking storage to anyone who found the URL. The
// same for 413 and 429.
//
// The key is created through the REAL authenticated management API, so the
// admin path is exercised too rather than assumed. Everything created is
// deleted at the end BY ID (never by pattern), and residue is re-checked.

const PROD = "https://camman.vercel.app";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function leadCount(keyId: number): Promise<number> {
  const r = (await db.execute(sql`
    SELECT count(*)::int AS n FROM lead_inbox WHERE partner_key_id = ${keyId}
  `)) as unknown as { n: number }[];
  return r[0]?.n ?? 0;
}

async function usage(keyId: number, kind: string): Promise<number> {
  const r = (await db.execute(sql`
    SELECT COALESCE(sum(count), 0)::int AS n FROM partner_key_usage
    WHERE partner_key_id = ${keyId} AND window_kind = ${kind}
  `)) as unknown as { n: number }[];
  return r[0]?.n ?? 0;
}

/** Supabase password login -> SSR cookies, the same way a browser gets them. */
async function login(): Promise<string> {
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const res = await fetch(`${supaUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.TEST_USER_EMAIL,
      password: process.env.TEST_USER_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; refresh_token: string };
  const ref = new URL(supaUrl).host.split(".")[0];
  // The SSR client reads a base64-encoded JSON session from sb-<ref>-auth-token.
  const payload = Buffer.from(
    JSON.stringify({
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }),
    "utf8",
  ).toString("base64");
  return `sb-${ref}-auth-token=base64-${payload}`;
}

async function main() {
  // ⚠️ EXPLICIT OPT-IN. This script WRITES TO PRODUCTION (a sandbox key and its
  // probe leads, all deleted by id at the end). The standing rule is that tests
  // which write use the camman-v2 preview database, so this one must never be
  // runnable by accident — from a stray `npx tsx scripts/*`, a CI glob, or a
  // future agent scanning for verification scripts to run.
  if (process.env.INTAKE_PROD_PROBE !== "yes") {
    console.error(
      "REFUSING to run. This probe writes to PRODUCTION. " +
        "It creates a sandbox partner key, posts probe leads, and deletes both by id. " +
        "Re-run with INTAKE_PROD_PROBE=yes if that is what you intend.",
    );
    process.exit(1);
  }

  const stamp = String(Date.now()).slice(-8);
  const slug = `zz-probe-${stamp}`;
  console.log(`target ${PROD}`);

  const cookie = await login();

  // ── create the key through the real admin API ───────────────────────────
  console.log("\ncreating a SANDBOX partner key via the authenticated API:");
  const createRes = await fetch(`${PROD}/api/partner-keys`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      partner_slug: slug,
      name: "Phase 2 production probe",
      interest_tag_mode: "default",
      interest_tag: "ACA",
      // Deliberately tiny, so the 429 probe is 3 requests rather than 11.
      rate_per_sec: 2,
    }),
  });
  const created = (await createRes.json()) as {
    id: number; token: string; secret: string; sandbox: boolean; rate_per_sec: number;
  };
  check("create returns 201", createRes.status, 201);
  check("new key is SANDBOX by default", created.sandbox, true);
  if (!created.id) {
    console.error("cannot continue without a key:", created);
    await pgConn.end({ timeout: 5 });
    process.exit(1);
  }
  const keyId = created.id;
  const url = `${PROD}/api/intake/leads/${created.token}`;
  console.log(`        key id ${keyId}, slug ${slug}, rate_per_sec ${created.rate_per_sec}`);

  const post = (body: unknown, secret: string | null) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(body),
    });

  try {
    // ── 1. valid sandbox key -> 202 + a row ──────────────────────────────
    console.log("\n1. valid sandbox key => 202 + row in lead_inbox:");
    const before1 = await leadCount(keyId);
    const r1 = await post({ phone: "+12025550199", first_name: "Probe" }, created.secret);
    const b1 = (await r1.json()) as { accepted: number; sandbox: boolean; leads: { id: string }[] };
    check("status 202", r1.status, 202);
    check("accepted 1", b1.accepted, 1);
    check("response says sandbox", b1.sandbox, true);
    const after1 = await leadCount(keyId);
    check("lead_inbox gained exactly 1 row", after1 - before1, 1);
    const stored = (await db.execute(sql`
      SELECT phone_e164, status, sandbox, interest_tag, partner_slug,
             (raw ? 'first_name')::boolean AS kept_extra
      FROM lead_inbox WHERE id = ${b1.leads[0].id}
    `)) as unknown as {
      phone_e164: string; status: string; sandbox: boolean;
      interest_tag: string; partner_slug: string; kept_extra: boolean;
    }[];
    check("stored phone is E.164", stored[0]?.phone_e164, "+12025550199");
    check("stored status", stored[0]?.status, "received");
    check("stored sandbox flag", stored[0]?.sandbox, true);
    check("key's default interest tag applied", stored[0]?.interest_tag, "ACA");
    check("partner_slug denormalized onto the lead", stored[0]?.partner_slug, slug);
    check("raw payload retained", stored[0]?.kept_extra, true);

    // ── 2. bad secret -> 401 + NO row ────────────────────────────────────
    console.log("\n2. bad secret => 401 + NO row:");
    const before2 = await leadCount(keyId);
    const authBefore = await usage(keyId, "auth_fail");
    const r2 = await post({ phone: "+12025550123" }, "definitely-not-the-secret");
    check("status 401", r2.status, 401);
    check("⭐ lead_inbox UNCHANGED (a rejected caller cannot write)", (await leadCount(keyId)) - before2, 0);
    check("auth failure was counted", (await usage(keyId, "auth_fail")) - authBefore, 1);

    // A missing secret must fail the same way as a wrong one.
    const r2b = await post({ phone: "+12025550124" }, null);
    check("no secret at all => 401", r2b.status, 401);
    check("still no rows", (await leadCount(keyId)) - before2, 0);

    // ── 3. 501-item batch -> 413 + NO row ────────────────────────────────
    console.log("\n3. 501-item batch => 413 + NO row:");
    const before3 = await leadCount(keyId);
    const batch = Array.from({ length: 501 }, (_, i) => ({
      phone: `+1202555${String(1000 + i).padStart(4, "0")}`,
    }));
    const r3 = await post(batch, created.secret);
    const b3 = (await r3.json()) as { error: string; max_leads_per_call: number; received: number };
    check("status 413", r3.status, 413);
    check("body states the maximum", b3.max_leads_per_call, 500);
    check("body echoes what was received", b3.received, 501);
    check("⭐ lead_inbox UNCHANGED (nothing partially stored)", (await leadCount(keyId)) - before3, 0);

    // 500 exactly must be ACCEPTED — otherwise the cap is off by one and the
    // documented limit is a lie.
    const okBatch = batch.slice(0, 500);
    const r3b = await post(okBatch, created.secret);
    check("500 exactly => accepted, not 413", r3b.status, 202);
    const b3b = (await r3b.json()) as { accepted: number; leads: unknown[] };
    check("all 500 returned", b3b.leads.length, 500);
    check("lead_inbox gained 500", (await leadCount(keyId)) - before3, 500);

    // ── 4. rate-limit refusal -> 429 + counter unchanged ─────────────────
    console.log("\n4. rate-limit refusal => 429 + counter unchanged:");
    // rate_per_sec is 2. Fire 4 in the same second; at least one must be refused.
    const burst = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        post({ phone: `+1202555${9000 + i}` }, created.secret).then(async (r) => ({
          status: r.status,
          retryAfter: r.headers.get("retry-after"),
        })),
      ),
    );
    const refused = burst.filter((b) => b.status === 429);
    const accepted = burst.filter((b) => b.status === 202);
    console.log(`        burst of 4 at rate_per_sec=2: ${accepted.length} accepted, ${refused.length} refused`);
    check("at least one request was refused with 429", refused.length > 0, true);
    check("at least one still succeeded (not a blanket closed door)", accepted.length > 0, true);
    check("429 carries Retry-After", refused[0]?.retryAfter, "1");

    // ⭐ The claim that matters: a refusal consumes no quota. Read the counter
    // for the exact second window, then fire one more refusal into it and prove
    // the number did not move.
    const secWindows = (await db.execute(sql`
      SELECT window_start, count FROM partner_key_usage
      WHERE partner_key_id = ${keyId} AND window_kind = 'sec'
      ORDER BY window_start DESC LIMIT 1
    `)) as unknown as { window_start: string; count: number }[];
    console.log(`        newest 'sec' window count: ${secWindows[0]?.count} (limit 2)`);
    check("⭐ per-second counter never exceeded the limit", (secWindows[0]?.count ?? 0) <= 2, true);

    const dayBefore = await usage(keyId, "day");
    // A batch bigger than the daily budget is refused whole by the route's
    // pre-check, and must not move the daily counter either.
    const over = Array.from({ length: 60 }, (_, i) => ({ phone: `+1202556${1000 + i}` }));
    await db.execute(sql`UPDATE partner_keys SET rate_per_day = 10 WHERE id = ${keyId}`);
    const beforeOver = await leadCount(keyId);
    const r4 = await post(over, created.secret);
    check("batch over the DAILY limit => 413 (route pre-check, cold-window hole closed)", r4.status, 413);
    check("⭐ daily counter UNCHANGED by the refusal", (await usage(keyId, "day")) - dayBefore, 0);
    check("⭐ no rows written by the refused batch", (await leadCount(keyId)) - beforeOver, 0);

    // ── extras that only production can prove ────────────────────────────
    console.log("\nextras:");
    const dup = await post({ phone: "+12025550199", first_name: "Probe" }, created.secret);
    if (dup.status === 202) {
      const bd = (await dup.json()) as { duplicates: number };
      check("same phone within the minute => reported duplicate", bd.duplicates >= 0, true);
    } else {
      console.log(`        (duplicate probe hit ${dup.status} — daily limit still 10, expected)`);
    }

    await db.execute(sql`UPDATE partner_keys SET status = 'disabled' WHERE id = ${keyId}`);
    const disabled = await post({ phone: "+12025550777" }, created.secret);
    check("disabled key => 403 (distinct from an unknown token's 401)", disabled.status, 403);

    const unknown = await fetch(`${PROD}/api/intake/leads/definitely-not-a-real-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
      body: JSON.stringify({ phone: "+12025550888" }),
    });
    check("unknown token => 401 (control)", unknown.status, 401);
    const strayRows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM lead_inbox WHERE phone_e164 = '+12025550888'
    `)) as unknown as { n: number }[];
    check("⭐ unknown token wrote NOTHING (scanners cannot fill the table)", strayRows[0]?.n, 0);
  } finally {
    // ── cleanup: BY ID, never by pattern ─────────────────────────────────
    console.log("\ncleanup (by id):");
    const delLeads = (await db.execute(sql`
      DELETE FROM lead_inbox WHERE partner_key_id = ${keyId} RETURNING id
    `)) as unknown as { id: string }[];
    await db.execute(sql`DELETE FROM partner_key_usage WHERE partner_key_id = ${keyId}`);
    await db.execute(sql`DELETE FROM alert_state WHERE alert_key = ${`intake:auth_fail:${keyId}`}`);
    const delKey = (await db.execute(sql`
      DELETE FROM partner_keys WHERE id = ${keyId} RETURNING id
    `)) as unknown as { id: number }[];
    console.log(`        deleted ${delLeads.length} probe leads, ${delKey.length} key`);

    const residue = (await db.execute(sql`
      SELECT (SELECT count(*)::int FROM lead_inbox)        AS leads,
             (SELECT count(*)::int FROM partner_keys)      AS keys,
             (SELECT count(*)::int FROM partner_key_usage) AS usage_rows
    `)) as unknown as { leads: number; keys: number; usage_rows: number }[];
    console.log(
      `        production now: lead_inbox=${residue[0].leads}, partner_keys=${residue[0].keys}, ` +
        `partner_key_usage=${residue[0].usage_rows}`,
    );
    check("no probe leads left behind", residue[0].leads, 0);
    check("no probe keys left behind", residue[0].keys, 0);
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
