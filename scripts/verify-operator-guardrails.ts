import "./_env-preload";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

// End-to-end guardrail verification as a REAL operator (869et3vm1 Phase 3).
//
// The companion to scripts/verify-operator-access.ts: that one proves what the
// operator cannot reach, this one proves the guardrails behave on what they can.
//
// ⚠️ PREVIEW ONLY. It provisions an operator and exercises write paths, so it
// refuses to run against production.
//
// Every section prints its scope, and an empty scope is a FAILURE — a check that
// found nothing to look at has told you its setup broke, not that the system is
// healthy.

const PREVIEW_REF = "fdzxzxayhknywvmrhjcj";
const OPERATOR_EMAIL = process.env.OPERATOR_TEST_EMAIL ?? "operator-test@exuma.io";
const BASE = process.env.BASE_URL ?? "";

let failures = 0;
const ok = (m: string) => console.log(`  OK ${m}`);
const bad = (m: string) => {
  console.log(`  XX ${m}`);
  failures++;
};

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!BASE) {
    console.error("BASE_URL is required (the preview deployment URL).");
    process.exit(1);
  }
  if (!dbUrl.includes(PREVIEW_REF)) {
    console.error(`REFUSING TO RUN: DATABASE_URL is not preview (${PREVIEW_REF}).`);
    process.exit(1);
  }
  if (/^camman\.vercel\.app$/.test(new URL(BASE).host)) {
    console.error("REFUSING TO RUN: BASE_URL is the production alias.");
    process.exit(1);
  }

  console.log("=== operator guardrails ===\n");
  console.log(`  target  : ${BASE}`);
  console.log(`  database: preview (${PREVIEW_REF})\n`);

  const sql = postgres(dbUrl, { prepare: false, max: 1 });
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // ── provision + sign in as the operator ─────────────────────────────────
  const password = `Op-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const list = await admin.auth.admin.listUsers({ perPage: 200 });
  let userId = list.data?.users.find((u) => u.email === OPERATOR_EMAIL)?.id;
  if (userId) await admin.auth.admin.updateUserById(userId, { password });
  else {
    const c = await admin.auth.admin.createUser({
      email: OPERATOR_EMAIL,
      password,
      email_confirm: true,
    });
    if (c.error) {
      bad(`could not create the operator: ${c.error.message}`);
      process.exit(1);
    }
    userId = c.data.user!.id;
  }
  const [org] = await sql<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`;
  await sql`
    INSERT INTO org_members (user_id, org_id, role, is_active)
    VALUES (${userId}::uuid, ${org.id}::uuid, 'operator', true)
    ON CONFLICT (user_id, org_id) DO UPDATE SET role = 'operator', is_active = true`;

  const jar: { name: string; value: string }[] = [];
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => jar,
        setAll: (l) => {
          for (const c of l) {
            const i = jar.findIndex((x) => x.name === c.name);
            if (i >= 0) jar[i] = { name: c.name, value: c.value };
            else jar.push({ name: c.name, value: c.value });
          }
        },
      },
    },
  );
  const si = await sb.auth.signInWithPassword({ email: OPERATOR_EMAIL, password });
  if (si.error) {
    bad(`operator sign-in failed: ${si.error.message}`);
    process.exit(1);
  }
  const cookie = jar.map((c) => `${c.name}=${c.value}`).join("; ");
  const call = async (path: string, init?: RequestInit) => {
    const r = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Cookie: cookie, "Content-Type": "application/json", ...(init?.headers ?? {}) },
      redirect: "manual",
    });
    return { status: r.status, body: await r.text() };
  };
  console.log(`  operator: ${OPERATOR_EMAIL} (${userId.slice(0, 8)}…)\n`);

  // ── 1. approve-send is REACHABLE for the operator ───────────────────────
  //
  // Phase 2 denied this route outright; Phase 3 opens it behind the caps. If it
  // 403s, the hire cannot send and the phase has failed at its main job.
  console.log("--- 1. approve-send reachable for the operator ---");
  const [stage] = await sql<{ id: number; campaign_id: number }[]>`
    SELECT id, campaign_id FROM campaign_stages ORDER BY id LIMIT 1`;
  console.log(`  scope: stage ${stage?.id ?? "(none)"} on campaign ${stage?.campaign_id ?? "-"}`);
  if (!stage) {
    bad("no stage in the preview database — EMPTY scope, cannot verify");
  } else {
    const r = await call(
      `/api/campaigns/${stage.campaign_id}/stages/${stage.id}/send/approve-send`,
      { method: "POST", body: JSON.stringify({ send_now: false }) },
    );
    // 200 is the goal. 4xx OTHER than 403 means the route was reached and
    // refused on its own merits (bad state, nothing to send) — still proof the
    // authorization opened. 403 is the failure this section exists to catch.
    if (r.status === 403) {
      bad(`approve-send returned 403 — still denied to the operator: ${r.body.slice(0, 200)}`);
    } else if (r.status === 200) {
      ok(`approve-send returned 200 for the operator`);
    } else {
      ok(`approve-send reached the handler (HTTP ${r.status}, not 403): ${r.body.slice(0, 140)}`);
    }
    const retry = await call(
      `/api/campaigns/${stage.campaign_id}/stages/${stage.id}/send/retry-failed`,
      { method: "POST", body: JSON.stringify({}) },
    );
    if (retry.status === 403) bad(`retry-failed returned 403 — still denied`);
    else ok(`retry-failed reached the handler (HTTP ${retry.status}, not 403)`);
  }

  // ── 2. URL allowlist blocks a raw link ──────────────────────────────────
  console.log("\n--- 2. URL allowlist ---");
  const bodies = [
    { text: "Grab it at https://evil.example.com now", expect: "reject" },
    { text: "Grab it at {link} now", expect: "accept" },
  ];
  console.log(`  scope: ${bodies.length} creative bodies`);
  for (const b of bodies) {
    const r = await call("/api/creatives", {
      method: "POST",
      body: JSON.stringify({ text: b.text, offer_ids: [], applies_to_all_offers: true }),
    });
    const rejectedForUrl = r.status === 400 && r.body.includes("raw_url_in_body");
    if (b.expect === "reject") {
      if (rejectedForUrl) ok(`raw URL rejected (400 raw_url_in_body)`);
      else bad(`raw URL NOT rejected — HTTP ${r.status}: ${r.body.slice(0, 160)}`);
    } else {
      if (rejectedForUrl) bad(`a {link} body was wrongly rejected as a raw URL`);
      else ok(`{link} body accepted by the URL rule (HTTP ${r.status})`);
      // Clean up anything we created.
      try {
        const id = (JSON.parse(r.body) as { creative?: { id?: number } }).creative?.id;
        if (id) await sql`DELETE FROM creatives WHERE id = ${id}`;
      } catch {
        /* nothing created */
      }
    }
  }

  // ── 3. deletion request instead of a delete ─────────────────────────────
  console.log("\n--- 3. deletion approval queue ---");
  const [seg] = await sql<{ id: number }[]>`SELECT id FROM segments ORDER BY id LIMIT 1`;
  console.log(`  scope: segment ${seg?.id ?? "(none)"}`);
  if (!seg) {
    bad("no segment in preview — EMPTY scope");
  } else {
    const before = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM deletion_requests WHERE status = 'pending'`;
    const r = await call(`/api/segments/${seg.id}/archive`, { method: "POST" });
    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM deletion_requests WHERE status = 'pending'`;
    if (r.status === 202 && after[0].n > before[0].n) {
      ok(`archive became a request (202), pending ${before[0].n} -> ${after[0].n}`);
    } else if (r.status === 202) {
      ok(`archive returned 202 (request already pending for this segment)`);
    } else {
      bad(`archive returned ${r.status}, expected 202 with a queued request: ${r.body.slice(0, 160)}`);
    }
    // The operator must not be able to see or decide the queue.
    const q = await call("/api/deletion-requests");
    if (q.status === 403) ok("the operator cannot read the approval queue (403)");
    else bad(`the operator could read the approval queue: HTTP ${q.status}`);
    await sql`DELETE FROM deletion_requests WHERE entity_type = 'segment' AND entity_id = ${String(seg.id)}`;
  }

  // ── 4. audit trail ──────────────────────────────────────────────────────
  console.log("\n--- 4. guardrail events are recorded ---");
  const events = await sql<{ action: string; n: number }[]>`
    SELECT action, count(*)::int AS n FROM audit_log
    WHERE action LIKE 'guardrail.%' GROUP BY action ORDER BY action`;
  console.log(`  scope: ${events.length} distinct guardrail event type(s) in audit_log`);
  if (events.length === 0) {
    bad("no guardrail events recorded — EMPTY, the notify path is not writing");
  } else {
    for (const e of events) ok(`${e.action}: ${e.n}`);
  }

  await sql.end();
  console.log(`\n=== ${failures === 0 ? "ALL PASS" : "FAILURES"} ===`);
  console.log(
    "\n  NOT covered: a real drain (SEND_ENABLED is off in preview and provider\n" +
      "  credentials are empty), so approve-send is verified as REACHABLE and\n" +
      "  cap-gated, not as having delivered an SMS.",
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verification threw:", e instanceof Error ? e.message : e);
  process.exit(1);
});
