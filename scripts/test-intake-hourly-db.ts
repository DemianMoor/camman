// lead_intake_hourly (0199) write path + hourly digest, against the PREVIEW
// database, inside ONE transaction that is rolled back — nothing survives.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' .env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-intake-hourly-db.ts
//
// Proves: (1) bumpIntakeCounters writes the daily AND hourly row with the same
// deltas, hour = processing hour; (2) the day-sum invariant holds, and a
// tampered hourly row is reported; (3) the two writes are ONE statement — an
// hourly CHECK failure leaves the daily row untouched; (4) the digest skips the
// partial first hour, carries the first-digest note on the next, and reports
// the right numbers; (5) hourStart keeps the two DST fall-back 01:00s apart.
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bumpIntakeCounters, hourStart } from "@/lib/drip/counters";
import { buildIntakeDigest, checkDaySumInvariant } from "@/lib/drip/intake-digest";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}
const ROLLBACK = Symbol("rollback");

// ── pure: DST fall-back ─────────────────────────────────────────────────────
{
  const edt = hourStart(new Date("2026-11-01T05:30:00Z")); // 01:30 EDT
  const est = hourStart(new Date("2026-11-01T06:30:00Z")); // 01:30 EST
  check("DST: two 01:00 ET hours are distinct", edt.toISOString() === "2026-11-01T05:00:00.000Z" && est.toISOString() === "2026-11-01T06:00:00.000Z");
}

// A past ET day well clear of any real row: 2026-01-14 (EST, UTC-5).
const H13 = new Date("2026-01-14T18:00:00Z"); // 13:00 ET
const H14 = new Date("2026-01-14T19:00:00Z"); // 14:00 ET
const at = (iso: string) => new Date(iso);

async function main() {
  try {
    await db.transaction(async (tx) => {
      const org = (await tx.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as { id: string }[];
      const orgId = org[0].id;
      const key = (await tx.execute(sql`
        INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash, sandbox)
        VALUES (${orgId}::uuid, 'zztest', 'hourly test', 'tok-hourly-test', 'x', false)
        RETURNING id`)) as unknown as { id: number }[];
      const k = key[0].id;
      const bump = (iso: string, deltas: Record<string, number>, tag = "aca") =>
        bumpIntakeCounters(tx, { orgId, partnerKeyId: k, at: at(iso), interestTag: tag, deltas });

      // 13:xx ET — the partial "first" hour
      await bump("2026-01-14T18:20:00Z", { received: 1, mobile: 1 });
      await bump("2026-01-14T18:45:00Z", { received: 1, landline: 1 });
      await bump("2026-01-14T18:50:00Z", { lookups_spent: 3 });
      // 14:xx ET — first full hour, two tags
      await bump("2026-01-14T19:05:00Z", { received: 1, mobile: 1 });
      await bump("2026-01-14T19:10:00Z", { received: 1, voip: 1 });
      await bump("2026-01-14T19:11:00Z", { lookups_spent: 2 });
      await bump("2026-01-14T19:30:00Z", { received: 1, unknown: 1 }, "");
      await bump("2026-01-14T19:31:00Z", { sandbox: 1 }, "");

      const hourly = (await tx.execute(sql`
        SELECT hour_et, interest_tag, received, mobile, voip, unknown, landline, sandbox, lookups_spent
        FROM lead_intake_hourly WHERE partner_key_id = ${k} ORDER BY hour_et, interest_tag`)) as unknown as Record<string, unknown>[];
      check("hourly: 3 rows (13 aca, 14 '', 14 aca)", hourly.length === 3, JSON.stringify(hourly));
      const h13 = hourly.find((r) => new Date(r.hour_et as string).getTime() === H13.getTime() && r.interest_tag === "aca");
      check("hourly 13:00 = 2 received / 1 mobile / 1 landline / 3 lookups",
        !!h13 && h13.received === 2 && h13.mobile === 1 && h13.landline === 1 && h13.lookups_spent === 3, JSON.stringify(h13));
      const daily = (await tx.execute(sql`
        SELECT interest_tag, received, mobile, voip, unknown, landline, sandbox, lookups_spent
        FROM lead_intake_daily WHERE partner_key_id = ${k} ORDER BY interest_tag`)) as unknown as Record<string, unknown>[];
      const dAca = daily.find((r) => r.interest_tag === "aca");
      check("daily aca = 4 received / 5 lookups (sum of both hours)", !!dAca && dAca.received === 4 && dAca.lookups_spent === 5, JSON.stringify(daily));

      // Invariant: holds; then a tamper is reported with exact numbers.
      const dayStart = new Date("2026-01-14T05:00:00Z");
      const ok = await checkDaySumInvariant(tx, orgId, H14, dayStart);
      const mine = (b: { partner: string }) => b.partner === "zztest";
      check("invariant holds", !!ok && ok.day === "2026-01-14" && ok.breaks.filter(mine).length === 0, JSON.stringify(ok));
      await tx.execute(sql`UPDATE lead_intake_hourly SET received = received + 1 WHERE partner_key_id = ${k} AND hour_et = ${H14.toISOString()}::timestamptz AND interest_tag = 'aca'`);
      const bad = await checkDaySumInvariant(tx, orgId, H14, dayStart);
      const br = bad?.breaks.filter(mine) ?? [];
      check("tampered hourly row reported", br.length === 1 && br[0].column === "received" && br[0].hourlySum === 5 && br[0].daily === 4, JSON.stringify(br));
      await tx.execute(sql`UPDATE lead_intake_hourly SET received = received - 1 WHERE partner_key_id = ${k} AND hour_et = ${H14.toISOString()}::timestamptz AND interest_tag = 'aca'`);
      check("invariant skipped when tracking began mid-day", (await checkDaySumInvariant(tx, orgId, H14, H13)) === null);

      // Atomicity: a delta that breaks the HOURLY nonneg CHECK (a fresh hour
      // starts at 0) but not the daily one (already 4) must change neither.
      let threw = false;
      try {
        await tx.transaction(async (sp) => {
          await bumpIntakeCounters(sp, { orgId, partnerKeyId: k, at: at("2026-01-14T21:10:00Z"), interestTag: "aca", deltas: { received: -1 } });
        });
      } catch {
        threw = true;
      }
      const after = (await tx.execute(sql`SELECT received FROM lead_intake_daily WHERE partner_key_id = ${k} AND interest_tag = 'aca'`)) as unknown as { received: number }[];
      check("hourly CHECK failure rolls back the daily write too", threw && after[0].received === 4, `threw=${threw} daily=${after[0]?.received}`);

      // Digest. Earliest hourly row for this org is our 13:00 (preview has no other rows).
      const firstRow = (await tx.execute(sql`SELECT min(hour_et) AS f FROM lead_intake_hourly WHERE org_id = ${orgId}::uuid`)) as unknown as { f: string }[];
      check("fixture's 13:00 is the org's first tracked hour", new Date(firstRow[0].f).getTime() === H13.getTime(), String(firstRow[0].f));

      const d13 = await buildIntakeDigest({ dbc: tx, now: H14 });
      const s13 = d13.orgs.find((o) => o.orgId === orgId);
      check("13:00 (partial first hour) skipped on schedule", s13?.skipped === "partial_first_hour" && d13.messages.length === 0, JSON.stringify(d13.orgs));

      const d14 = await buildIntakeDigest({ dbc: tx, now: new Date("2026-01-14T20:00:30Z") });
      const msg = d14.messages.join("\n");
      check("14:00 digest built, one message", d14.hour === H14.toISOString() && d14.messages.length === 1, JSON.stringify(d14.orgs));
      check("window label", msg.includes("14:00–15:00 ET · Wed 14 Jan"), msg);
      check("table: aca row 2 leads / 1 mobile / 2 lookups", /zztest +aca +2 +1 +2 /.test(msg), msg);
      check("table: untagged row 1 lead, sandbox not counted", /zztest +\(untagged\) +1 +0 +0 /.test(msg), msg);
      check("TOTAL row", /TOTAL +3 +1 +2 /.test(msg), msg);
      check("first-digest note names the 13:00 hour", msg.includes("First hourly digest") && msg.includes("13:00 ET hour on Wed 14 Jan"), msg);
      check("footer states rate + balance", msg.includes("2 lookups × $") && msg.includes("Telnyx balance:"), msg);
      check("invariant not checked (tracking began mid-day) → no warning", !msg.includes("Day-sum"));
      console.log("\n--- rendered 14:00 digest ---\n" + msg + "\n---");

      const m13 = await buildIntakeDigest({ dbc: tx, now: new Date(), hour: H13, manual: true });
      const mm = m13.messages.join("\n");
      check("manual re-run of 13:00 renders, marked, no first note", mm.includes("(manual re-run)") && mm.includes("2 leads · 1 mobile") && !mm.includes("First hourly"), mm);

      const d15 = await buildIntakeDigest({ dbc: tx, now: new Date("2026-01-14T21:00:10Z") });
      check("hour with no intake → no message", d15.messages.length === 0 && d15.orgs.length === 0, JSON.stringify(d15));

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  const left = (await db.execute(sql`SELECT count(*)::int AS n FROM partner_keys WHERE token = 'tok-hourly-test'`)) as unknown as { n: number }[];
  check("rolled back: no fixture survives", left[0].n === 0);
  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
