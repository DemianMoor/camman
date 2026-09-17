import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import type { ConversionEventInsert } from "../lib/conversions/build-rows";
import { upsertConversionEvents } from "../lib/conversions/ingest";

// Upsert semantics of the conversion_events ledger, run through the REAL exported
// write path inside a transaction that always rolls back. PREVIEW DB ONLY:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx scripts/test-conversion-events-upsert.ts
const PROD_REF = "rtdarhkkjwcetlmruftl";
if ((process.env.DATABASE_URL ?? "").includes(PROD_REF)) {
  console.log("Refusing to run against PROD. Point DATABASE_URL at camman-v2 (.env.demo).");
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

class Rollback extends Error {}
const RUN = `test-ce-${Date.now()}`;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface Row {
  event_type_id: number | null;
  status: string | null;
  keitaro_type: string;
  conflicting_event_type_id: number | null;
  has_conflict_at: boolean;
  occurred_et: string;
  last_postback_et: string | null;
}
async function rowOf(tx: Tx, id: string): Promise<Row | undefined> {
  const rows = (await tx.execute(sql`
    SELECT event_type_id, status, keitaro_type, conflicting_event_type_id,
           event_type_conflict_at IS NOT NULL AS has_conflict_at,
           to_char(occurred_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS occurred_et,
           to_char(last_postback_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS last_postback_et
    FROM conversion_events WHERE keitaro_event_id = ${id}
  `)) as unknown as Row[];
  return rows[0];
}

async function main() {
  const host = process.env.DATABASE_URL?.includes("fdzxzxayhknywvmrhjcj") ? "camman-v2 (preview)" : "UNKNOWN";
  console.log(`Target DB: ${host}\n`);
  if (host === "UNKNOWN") {
    console.log("FAIL: DATABASE_URL is not the preview project.");
    process.exit(1);
  }

  try {
    await db.transaction(async (tx) => {
      const [org] = (await tx.execute(
        sql`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`,
      )) as unknown as { id: string }[];
      const types = (await tx.execute(
        sql`SELECT id, key FROM event_types WHERE org_id = ${org.id}::uuid`,
      )) as unknown as { id: number; key: string }[];
      const purchase = types.find((t) => t.key === "purchase")?.id ?? null;
      const registration = types.find((t) => t.key === "registration")?.id ?? null;
      check("U0 seeded event types exist for the org", purchase !== null && registration !== null, JSON.stringify(types));

      const base = (over: Partial<ConversionEventInsert>): ConversionEventInsert => ({
        orgId: org.id,
        keitaroEventId: `${RUN}-x`,
        tid: null,
        keitaroClickSubid: "clk.1",
        keitaroStatus: "lead",
        keitaroType: "lead",
        keitaroVersion: 1,
        keitaroOfferId: null,
        stageSendId: null,
        contactId: null,
        campaignId: null,
        stageId: null,
        offerId: null,
        eventTypeId: purchase,
        status: "pending",
        revenue: "0.0000",
        currency: "USD",
        occurredAtEt: "2026-09-14 21:45:32",
        lastPostbackAtEt: "2026-09-14 21:45:32",
        statusHistory: "1. Lead (2026-09-14 21:45:32)",
        rawParams: { status: "lead" },
        ...over,
      });
      const reg = base({ keitaroEventId: `${RUN}-reg`, tid: "A", keitaroStatus: "registration", keitaroType: "registration", eventTypeId: registration, status: "approved" });
      const buy = base({ keitaroEventId: `${RUN}-buy`, tid: "B", revenue: "110.0000" });

      let r = await upsertConversionEvents(tx, [reg, buy]);
      check("U1 two tids on one click → two rows inserted", r.inserted === 2 && r.updated === 0, JSON.stringify(r));

      r = await upsertConversionEvents(tx, [reg, buy]);
      check("U2 duplicate postbacks → nothing inserted or updated", r.inserted === 0 && r.updated === 0, JSON.stringify(r));

      r = await upsertConversionEvents(tx, [
        { ...buy, keitaroVersion: 2, keitaroStatus: "sale", keitaroType: "sale", status: "approved", occurredAtEt: "2026-09-17 07:13:52", lastPostbackAtEt: "2026-09-17 07:13:52" },
      ]);
      check("U3 in-place status change on the same event_id → one update", r.inserted === 0 && r.updated === 1, JSON.stringify(r));
      const b = await rowOf(tx, buy.keitaroEventId);
      check("U4 status is now approved", b?.status === "approved", JSON.stringify(b));
      check("U5 occurred_at never moves on update", b?.occurred_et === "2026-09-14 21:45:32", JSON.stringify(b));
      check("U6 last_postback_at follows the re-post", b?.last_postback_et === "2026-09-17 07:13:52", JSON.stringify(b));

      r = await upsertConversionEvents(tx, [
        { ...reg, keitaroVersion: 2, keitaroStatus: "rejected", keitaroType: "rejected", eventTypeId: null, status: "rejected" },
      ]);
      const g = await rowOf(tx, reg.keitaroEventId);
      check("U7 a rejection with no event type keeps the registration's type", r.updated === 1 && g?.event_type_id === registration && g?.status === "rejected", JSON.stringify(g));

      const unk = base({ keitaroEventId: `${RUN}-unk`, keitaroStatus: "trash", keitaroType: "trash", eventTypeId: null, status: null });
      await upsertConversionEvents(tx, [unk]);
      const u = await rowOf(tx, unk.keitaroEventId);
      check("U8 unmapped conversion stored with NULL event type and status", u !== undefined && u.event_type_id === null && u.status === null, JSON.stringify(u));

      r = await upsertConversionEvents(tx, [{ ...unk, eventTypeId: purchase, status: "rejected" }]);
      const h = await rowOf(tx, unk.keitaroEventId);
      check("U9 a mapping added later heals the unmapped row on the next ingest", r.updated === 1 && h?.event_type_id === purchase && h?.status === "rejected", JSON.stringify(h));

      // Reused tid: the registration conversion comes back typed Sale, whose mapping names purchase.
      r = await upsertConversionEvents(tx, [
        { ...reg, keitaroVersion: 3, keitaroStatus: "sale", keitaroType: "sale", eventTypeId: purchase, status: "approved" },
      ]);
      const c = await rowOf(tx, reg.keitaroEventId);
      check(
        "U11 type changes category → event type stays locked, raw type stored, conflict recorded",
        r.updated === 1 && r.conflicts === 1 && c?.event_type_id === registration && c?.keitaro_type === "sale" && c?.conflicting_event_type_id === purchase && c?.has_conflict_at === true,
        JSON.stringify({ r, c }),
      );

      r = await upsertConversionEvents(tx, [
        { ...reg, keitaroVersion: 4, keitaroStatus: "rejected", keitaroType: "rejected", eventTypeId: null, status: "rejected" },
      ]);
      const c2 = await rowOf(tx, reg.keitaroEventId);
      check("U12 a later status-only update does NOT clear the conflict", r.updated === 1 && c2?.status === "rejected" && c2?.conflicting_event_type_id === purchase && c2?.has_conflict_at === true, JSON.stringify({ r, c2 }));

      r = await upsertConversionEvents(tx, [
        { ...reg, keitaroVersion: 5, keitaroStatus: "registration", keitaroType: "registration", eventTypeId: registration, status: "approved" },
      ]);
      const c3 = await rowOf(tx, reg.keitaroEventId);
      check("U13 an agreeing mapping clears the conflict", r.conflicts === 0 && c3?.conflicting_event_type_id === null && c3?.has_conflict_at === false, JSON.stringify({ r, c3 }));

      // Fix 1: a direct caller passing the same event twice must not hit Postgres 21000.
      r = await upsertConversionEvents(tx, [
        { ...buy, keitaroVersion: 9, revenue: "111.0000" },
        { ...buy, keitaroVersion: 10, revenue: "112.0000" },
      ]);
      const d = await tx.execute(sql`SELECT revenue::text AS revenue, keitaro_version FROM conversion_events WHERE keitaro_event_id = ${buy.keitaroEventId}`) as unknown as { revenue: string; keitaro_version: number }[];
      check("U14 duplicate event ids in one call are collapsed (last wins), no 21000", r.updated === 1 && d[0]?.keitaro_version === 10 && d[0]?.revenue === "112.0000", JSON.stringify({ r, d }));

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const [left] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM conversion_events WHERE keitaro_event_id LIKE ${`${RUN}%`}`,
  )) as unknown as { n: number }[];
  check("U10 rolled back — no residue", left.n === 0, `${left.n} rows left`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
