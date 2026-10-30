import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { applyPartnerKeyPatch, listKeyPostbacks } from "@/lib/partners/postbacks/config";
import { deliveryEnabled, recentTestPostbackExists, sendTestPostback } from "@/lib/partners/postbacks/deliver";
import type { SendResult } from "@/lib/partners/postbacks/http";
import { can } from "@/lib/permissions";
import { partnerKeyUpdateSchema } from "@/lib/validators/partner-keys";
import { createPartnerWithKey } from "./_partner-fixture";

// Partner-key postback config API (A1-A6), at FUNCTION level.
//
// The routes are thin wrappers (auth -> can() -> these functions -> JSON); driving them
// over HTTP needs a dev server + a role-switched session, so the logic they call is tested
// directly: applyPartnerKeyPatch (PATCH), sendTestPostback / recentTestPostbackExists /
// deliveryEnabled (test-fire), listKeyPostbacks (log). A6 asserts can() at the routes'
// decision point and the org scoping of every function (another org's key => not found / empty).
//
// Preview DB only. Fixtures are COMMITTED in throwaway orgs and deleted in `finally`.
//
// Run: node scripts/with-preview-env.mjs npx tsx --conditions=react-server --conditions=import scripts/test-partner-postbacks-api.ts

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
type Row = Record<string, unknown>;
const q = async <T = Row>(s: ReturnType<typeof sql>) => (await db.execute(s)) as unknown as T[];
const RUN = `pka-${Date.now().toString(36)}`;
const TPL = "https://pb.example.com/v1?c={conversion_id}&s={status}";
const PAYOUT_MSG = "{payout} needs “Include payout” switched on";

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}`);
  const orgId = (await q<{ id: string }>(sql`INSERT INTO organizations (name) VALUES (${RUN}) RETURNING id::text AS id`))[0].id;
  const orgB = (await q<{ id: string }>(sql`INSERT INTO organizations (name) VALUES (${RUN + "-b"}) RETURNING id::text AS id`))[0].id;
  const orgArr = `{${orgId},${orgB}}`;
  const partnerIds: number[] = [];
  const keyIds: number[] = [];
  try {
    const mk = async (org: string, slug: string) => {
      const k = await createPartnerWithKey(db, { orgId: org, slug: `${RUN}-${slug}`, name: `${RUN} ${slug}` });
      partnerIds.push(k.partnerId);
      keyIds.push(k.keyId);
      return k.keyId;
    };
    const patch = (keyId: number, body: Record<string, unknown>, org = orgId) => {
      const parsed = partnerKeyUpdateSchema.safeParse(body);
      if (!parsed.success) throw new Error(`schema rejected ${JSON.stringify(body)}: ${parsed.error.issues[0]?.message}`);
      return applyPartnerKeyPatch(db, { orgId: org, keyId, input: parsed.data });
    };
    const errOf = (o: Awaited<ReturnType<typeof patch>>) => (o.ok ? null : { status: o.status, error: o.error });
    const since = async (k: number) =>
      (await q<{ s: string | null }>(sql`SELECT postback_active_since::text AS s FROM partner_keys WHERE id = ${k}::int`))[0].s;

    // ── A1 ─────────────────────────────────────────────────────────────
    console.log("\nA1. enable / active_since:");
    const k1 = await mk(orgId, "a1");
    check("enable with no template => 400 + message", errOf(await patch(k1, { postback_enabled: true })),
      { status: 400, error: "A postback URL template is required to enable postbacks" });
    check("still disabled, active_since NULL", await since(k1), null);
    const on1 = await patch(k1, { postback_enabled: true, postback_url_template: TPL });
    check("enable with valid template => ok", on1.ok, true);
    const s1 = await since(k1);
    check("active_since set", s1 !== null, true);
    const noChange = await patch(k1, { name: "renamed" });
    check("unrelated patch keeps active_since", noChange.ok && (await since(k1)) === s1, true);
    await patch(k1, { postback_enabled: false });
    check("disable => active_since NULL", await since(k1), null);
    await new Promise((r) => setTimeout(r, 20));
    await patch(k1, { postback_enabled: true });
    const s2 = await since(k1);
    check("re-enable => newer timestamp", s2 !== null && s1 !== null && new Date(s2) > new Date(s1), true);
    check("clearing the template of an enabled key => 400",
      errOf(await patch(k1, { postback_url_template: "" })),
      { status: 400, error: "A postback URL template is required to enable postbacks" });

    // ── A2 ─────────────────────────────────────────────────────────────
    console.log("\nA2. {payout} vs include_payout:");
    const k2 = await mk(orgId, "a2");
    check("{payout} with include_payout false => 400",
      errOf(await patch(k2, { postback_url_template: "https://pb.example.com/p?x={payout}" })),
      { status: 400, error: PAYOUT_MSG });
    check("include_payout + template together => ok",
      (await patch(k2, { postback_include_payout: true, postback_url_template: "https://pb.example.com/p?x={payout}" })).ok, true);
    check("turning payout off while template has {payout} => 400",
      errOf(await patch(k2, { postback_include_payout: false })), { status: 400, error: PAYOUT_MSG });

    // ── A3 ─────────────────────────────────────────────────────────────
    console.log("\nA3. passthrough placeholders:");
    const k3 = await mk(orgId, "a3");
    check("{list_id} not in passthrough => 400",
      errOf(await patch(k3, { postback_url_template: "https://pb.example.com/p?l={list_id}" })),
      { status: 400, error: "Unknown placeholder {list_id}" });
    check("add passthrough + template => ok",
      (await patch(k3, { passthrough_fields: ["list_id"], postback_url_template: "https://pb.example.com/p?l={list_id}" })).ok, true);
    check("removing the field the template uses => 400",
      errOf(await patch(k3, { passthrough_fields: [] })), { status: 400, error: "Unknown placeholder {list_id}" });
    check("another org's key => 404", errOf(await patch(k3, { name: "x" }, orgB)), { status: 404, error: "Partner key not found" });

    // ── A4 ─────────────────────────────────────────────────────────────
    console.log("\nA4. test-fire:");
    const k4 = await mk(orgId, "a4");
    delete process.env.PARTNER_POSTBACKS_DELIVERY_ENABLED;
    check("kill switch off => deliveryEnabled() false (route: 409)", deliveryEnabled(), false);
    process.env.PARTNER_POSTBACKS_DELIVERY_ENABLED = "true";
    check("kill switch on => true", deliveryEnabled(), true);

    let threw = "";
    try { await sendTestPostback(db, { orgId, keyId: k4 }, async () => { throw new Error("must not send"); }); }
    catch (e) { threw = (e as Error).message; }
    check("no template => no_template (route: 400)", threw, "no_template");
    threw = "";
    try { await sendTestPostback(db, { orgId: orgB, keyId: k4 }); } catch (e) { threw = (e as Error).message; }
    check("another org's key => key_not_found (route: 404)", threw, "key_not_found");

    await patch(k4, { passthrough_fields: ["list_id"], postback_url_template: "https://pb.example.com/t?c={conversion_id}&l={list_id}&token=SECRET1" });
    check("no test row yet", await recentTestPostbackExists(db, { orgId, keyId: k4 }), false);
    const sent: string[] = [];
    const ok200 = async (url: string): Promise<SendResult> => { sent.push(url); return { status: 200, error: null, blocked: false, durationMs: 1 }; };
    const r = await sendTestPostback(db, { orgId, keyId: k4 }, ok200);
    check("sent exactly once", sent.length, 1);
    check("URL carries sample values", /[?&]l=test_list_id(&|$)/.test(sent[0]) && /c=test-/.test(sent[0]), true);
    check("result shape", { ok: r.ok, status_code: r.status_code, error: r.error, keys: Object.keys(r).sort() },
      { ok: true, status_code: 200, error: null, keys: ["error", "ok", "status_code", "url_masked"] });
    check("masked URL hides the secret", !r.url_masked.includes("SECRET1") && r.url_masked.includes("token=***"), true);
    const rows = await q<Row>(sql`SELECT is_test, conversion_event_id, status, attempts, last_response_code, last_error,
                                         delivered_at IS NOT NULL AS d, payload, last_url_masked
                                  FROM partner_postbacks WHERE partner_key_id = ${k4}::int`);
    check("exactly one is_test row", rows.length, 1);
    check("row fields", { t: rows[0].is_test, c: rows[0].conversion_event_id, s: rows[0].status, a: rows[0].attempts, code: rows[0].last_response_code, e: rows[0].last_error, d: rows[0].d },
      { t: true, c: null, s: "delivered", a: 1, code: 200, e: null, d: true });
    check("row stores the masked URL", rows[0].last_url_masked, r.url_masked);
    check("payload is the sample", (rows[0].payload as { fields: Row }).fields, { list_id: "test_list_id" });
    check("recent test row => rate limit applies (route: 429)", await recentTestPostbackExists(db, { orgId, keyId: k4 }), true);
    check("other org not rate-limited by it", await recentTestPostbackExists(db, { orgId: orgB, keyId: k4 }), false);

    const bad = await sendTestPostback(db, { orgId, keyId: k4 }, async () => ({ status: 500, error: null, blocked: false, durationMs: 1 }));
    check("500 => ok false, no retry", { ok: bad.ok, code: bad.status_code, error: bad.error }, { ok: false, code: 500, error: "HTTP 500" });
    const failedRow = await q<Row>(sql`SELECT status, attempts FROM partner_postbacks WHERE partner_key_id = ${k4}::int AND status = 'failed'`);
    check("failed test row, attempts 1", failedRow, [{ status: "failed", attempts: 1 }]);

    // ── A5 ─────────────────────────────────────────────────────────────
    console.log("\nA5. log:");
    const k5 = await mk(orgId, "a5");
    const kOther = await mk(orgId, "a5-other");
    for (let i = 0; i < 55; i++) {
      await db.execute(sql`INSERT INTO partner_postbacks (org_id, partner_key_id, is_test, payload, status, attempts, last_url_masked, created_at)
        VALUES (${orgId}::uuid, ${k5}::int, true, '{"x":1}'::jsonb, ${i % 5 === 0 ? "failed" : "delivered"}, 1, 'https://h.example/p?token=***',
                now() - make_interval(secs => ${55 - i}::float8))`);
    }
    await db.execute(sql`INSERT INTO partner_postbacks (org_id, partner_key_id, is_test, payload, status) VALUES (${orgId}::uuid, ${kOther}::int, true, '{}'::jsonb, 'failed')`);
    const all = await listKeyPostbacks(db, { orgId, keyId: k5, failedOnly: false });
    check("50 rows", all.length, 50);
    const times = all.map((x) => new Date(x.created_at).getTime());
    check("newest first", times.every((t, i) => i === 0 || times[i - 1] >= t), true);
    check("field set has no raw url / payload", Object.keys(all[0]).sort(),
      ["attempts", "conversion_event_id", "created_at", "delivered_at", "id", "is_test", "last_attempt_at", "last_error", "last_response_code", "last_url_masked", "status"]);
    const failedOnly = await listKeyPostbacks(db, { orgId, keyId: k5, failedOnly: true });
    check("failed=1 filters, this key only", failedOnly.length === 11 && failedOnly.every((x) => x.status === "failed"), true);
    check("other org sees nothing", (await listKeyPostbacks(db, { orgId: orgB, keyId: k5, failedOnly: false })).length, 0);

    // ── A6 ─────────────────────────────────────────────────────────────
    console.log("\nA6. permissions (can() at the routes' decision point):");
    for (const role of ["viewer", "operator", "manager"] as const) check(`${role} cannot manage keys`, can(role, "partner_keys.manage"), false);
    for (const role of ["admin", "owner"] as const) check(`${role} can`, can(role, "partner_keys.manage"), true);
  } finally {
    console.log("\ncleanup:");
    await db.execute(sql`DELETE FROM partner_postbacks WHERE org_id = ANY(${orgArr}::uuid[])`);
    if (keyIds.length) await db.execute(sql`DELETE FROM partner_keys WHERE id = ANY(${`{${keyIds.join(",")}}`}::int[])`);
    if (partnerIds.length) await db.execute(sql`DELETE FROM partners WHERE id = ANY(${`{${partnerIds.join(",")}}`}::int[])`);
    await db.execute(sql`DELETE FROM organizations WHERE id = ANY(${orgArr}::uuid[])`);
    const left = (await q<Row>(sql`
      SELECT (SELECT count(*)::int FROM organizations WHERE id = ANY(${orgArr}::uuid[])) AS orgs,
             (SELECT count(*)::int FROM partner_keys WHERE org_id = ANY(${orgArr}::uuid[])) AS keys,
             (SELECT count(*)::int FROM partners WHERE org_id = ANY(${orgArr}::uuid[])) AS partners,
             (SELECT count(*)::int FROM partner_postbacks WHERE org_id = ANY(${orgArr}::uuid[])) AS pbs`))[0];
    check("zero fixture rows remain", left, { orgs: 0, keys: 0, partners: 0, pbs: 0 });
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
