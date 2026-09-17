import "./_env-preload";

import { readFileSync } from "node:fs";

import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  CONVERSION_SIGNAL_STYLE,
  CONVERSION_STATUS_STYLES,
  CONVERSION_STATUS_UNKNOWN_STYLE,
  CONVERSION_UNMAPPED_STYLE,
  conversionAmount,
  conversionAmountLabel,
  conversionBadgeClass,
} from "@/lib/conversion-badge";
import { refreshCountedClickers } from "@/lib/reporting/counted-clickers";
import { ledgerHourQuery, saleWeightCandidates } from "@/lib/reporting/performance-report";
import { stageHourAggregate } from "@/lib/reporting/rollup";
import {
  approvedRevenueClause,
  latestConversionForSend,
  pendingRevenueClause,
  purchasedClause,
  purchasesBySendSelect,
  rescueSendIds,
} from "@/lib/sale-attribution";

// Phase 3 Task 4 red/green proof for the per-recipient READERS this task
// switched. PREVIEW DB ONLY:
//   DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-p3-task4-reader-switch-db.ts
//
// ⭐ EVERY BLOCK RUNS THE REAL CODE, NOT A RETYPED LOOKALIKE. A block that
// retypes a "simplified shape" of the query it is testing proves only that the
// typist agreed with themselves — and the first version of this script did
// exactly that, dropping the hour bucketing, the occurred_at range and the
// provider filter from the hourly block, which left the ONE change in Task 4
// that can move a number today completely untested. What each block reaches:
//
//   A  purchasesBySendSelect()  (lib/sale-attribution.ts)  — the real fragment
//      BOTH the partner report's `purchases` CTE and the rollup's `conv_sends`
//      CTE are built from, plus stageHourAggregate() (lib/reporting/rollup.ts),
//      the rollup's real exported aggregate, end to end.
//   B  saleWeightCandidates() (lib/reporting/performance-report.ts) — the real
//      `sale` weight-basis candidate set.
//   C  rescueSendIds() (lib/sale-attribution.ts) AND refreshCountedClickers()
//      (lib/reporting/counted-clickers.ts) — the real Rule F rebuild, writing
//      real counted_clickers rows inside the rolled-back transaction.
//   D  ledgerHourQuery() (lib/reporting/performance-report.ts) — the real hourly
//      query: ET hour bucketing, the occurred_at range and the provider filter.
//   E  latestConversionForSend() (lib/sale-attribution.ts) — the real activity
//      badge LATERAL — and conversionBadgeClass / conversionAmount
//      (lib/conversion-badge.ts), the real badge rendering decisions.
//
// WHAT CANNOT BE REACHED, AND WHY. Three surfaces execute against the
// module-level `db`, which cannot see this script's uncommitted fixtures:
// getPartnerReport(), trackedWeights() and getHourlyReport(). For each, the
// piece the switch actually changed was extracted into the exported fragment the
// block above executes, and the call site is covered only by the F-block source
// guards (a guard on a file, not on a screen — it proves the call site still
// calls the shared fragment, nothing more). Reaching them for real would mean
// committing fixtures to the preview DB, which this script will not do.
//
// The OLD (pre-switch) side of every red proof IS retyped — deliberately: that
// code no longer exists to import, and the whole point is to show the numbers it
// would have produced for these exact rows.
//
// ⭐ SOURCE-GREP NEEDLES MUST NEVER SPAN A LINE BREAK. This checkout is CRLF
// (core.autocrlf=true; .gitattributes pins only db/migrations/**), so a needle
// containing "\n" cannot match the file on disk — which made the F5 negative
// ALWAYS TRUE and its check permanently green: restoring the .tsx's old inline
// style map verbatim would not have failed it. A negative source assertion is
// exactly where that defect hides, because it looks like it is working. Use
// `flat()` (whitespace-collapsed) and/or a regex, never a multi-line literal.
// Note also that /bg-(emerald|amber|sky|slate)-\d00/ over that .tsx matches its
// SEND-status map, so negating it would be permanently RED — the discriminating
// string has to be one only the conversion copy carried.
//
// FIXTURES — eight recipients on one stage, each isolating one class. Every one
// writes the ledger row and the legacy stage_sends columns SEPARATELY, so a
// check can only pass against the switched code:
//   ledger_only      approved $42 purchase; sale_status/sale_revenue/converted_at
//                     all NULL on the send
//   legacy_only      sale_status='lead', sale_revenue=$100, converted_at set,
//                     NO ledger row at all
//   rejected_ledger  REJECTED $77 purchase + converted_at (the old poller stamped
//                     it on ANY conversion, rejected included)
//   two_conversions  TWO approved purchases, $30 + $12 — the +$715 class. The
//                     legacy columns hold only the LATEST ($12), and its
//                     converted_at is a NEXT-DAY re-post: the old stamp moved out
//                     of the ET day, which is correction class D.
//   unmapped         UNMAPPED SHAPE (a) — no mapping rule matched at all, so
//                     event_type_id AND status are both NULL (Keitaro type
//                     'upsell', $55). A class that SHRINKS a number: the legacy
//                     columns counted it as a $55 sale.
//   unmapped_status_only
//                    ⭐ UNMAPPED SHAPE (b) — a STATUS-ONLY mapping rule
//                     (MappingRule.eventTypeId null, lib/conversions/build-rows.ts):
//                     event_type_id NULL but status 'approved', $66. THE DANGEROUS
//                     ONE, and the reason shape (a) alone is not enough: (a) is
//                     over-determined, so a reader keyed on `status IS NOT NULL`
//                     alone passes it by accident while counting THIS row as real
//                     money. Nothing may count it: not a purchase, no revenue, no
//                     pending revenue, not rescued.
//   mapped_status_null
//                    ⭐ a MAPPED purchase type with a NULL status ($88). Reachable:
//                     build-rows sets `status: mapping?.status ?? null` while the
//                     upsert keeps event_type_id sticky via COALESCE
//                     (lib/conversions/ingest.ts), so an unrecognised Keitaro
//                     status on an already-mapped event leaves the type set and
//                     nulls the status. Counts nowhere (every clause needs a
//                     non-NULL status) and must not render as a purchase.
//   registration_0   an approved $0 Registration (is_purchase=false,
//                     counts_revenue=false) — not a purchase, not revenue, not
//                     rescued, and rendered with NO money.
//
// docs/superpowers/plans/2026-09-17-conversion-events-phase3.md (Task 4)

const PROD_REF = "rtdarhkkjwcetlmruftl";
const PREVIEW_REF = "fdzxzxayhknywvmrhjcj";
if ((process.env.DATABASE_URL ?? "").includes(PROD_REF)) {
  console.log("Refusing to run against PROD. Point DATABASE_URL at camman-v2 (.env.demo).");
  process.exit(1);
}

// The fixture ET day. Far from any real preview-DB data, and the block-D world
// state check asserts the ledger is empty inside this window before the fixtures
// land — so an exact expectation can never be satisfied by somebody else's rows.
const DAY = "2027-06-15";
const et = (t: string) => `${DAY}T${t}-04:00`; // June ⇒ EDT
const ET_DAY_START = `${DAY}T00:00:00-04:00`;
const ET_DAY_END = "2027-06-16T00:00:00-04:00";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
const render = (x: ReturnType<typeof sql>) =>
  new PgDialect().sqlToQuery(x).sql.replace(/\s+/g, " ").trim();
const money = (v: unknown) => Math.round(Number(v ?? 0) * 10000) / 10000;

class Rollback extends Error {}

async function main() {
  const ref = /postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1] ?? "";
  const host = ref === PREVIEW_REF ? "camman-v2 (preview)" : "UNKNOWN";
  console.log(`Target DB: ${host}\n`);
  if (host === "UNKNOWN") {
    console.log("FAIL: DATABASE_URL is not the preview project.");
    process.exit(1);
  }

  let sawTx = false;
  try {
    await db.transaction(async (tx: Tx) => {
      sawTx = true;
      const orgId = (
        (await tx.execute(sql`SELECT id::text AS id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as {
          id: string;
        }[]
      )[0]?.id;
      if (!orgId) throw new Error("no organization on the preview DB");

      const eventTypes = (await tx.execute(sql`
        SELECT id, key, is_purchase, counts_revenue FROM event_types WHERE org_id = ${orgId}::uuid
      `)) as unknown as { id: number; key: string; is_purchase: boolean; counts_revenue: boolean }[];
      const purchaseTypeId = eventTypes.find((t) => t.key === "purchase")?.id;
      const registrationTypeId = eventTypes.find((t) => t.key === "registration")?.id;
      check(
        "S0 the 0181 'purchase' + 'registration' event types are seeded on this org",
        purchaseTypeId != null && registrationTypeId != null,
        JSON.stringify(eventTypes),
      );
      check(
        "S1 the seed's flags are what the fixtures assume (purchase counts, registration does not)",
        eventTypes.find((t) => t.key === "purchase")?.is_purchase === true &&
          eventTypes.find((t) => t.key === "purchase")?.counts_revenue === true &&
          eventTypes.find((t) => t.key === "registration")?.is_purchase === false &&
          eventTypes.find((t) => t.key === "registration")?.counts_revenue === false,
        JSON.stringify(eventTypes),
      );
      if (purchaseTypeId == null || registrationTypeId == null) throw new Rollback();

      // ── world state, BEFORE the fixtures ────────────────────────────────────
      // Block D asserts exact hour buckets over the whole org, so it is only
      // meaningful if nothing else sits in the window. Name that world state
      // rather than assume it.
      const pre = (
        (await tx.execute(sql`
          SELECT count(*)::int AS n FROM conversion_events
          WHERE org_id = ${orgId}::uuid
            AND occurred_at >= ${ET_DAY_START}::timestamptz
            AND occurred_at < ${ET_DAY_END}::timestamptz
        `)) as unknown as { n: number }[]
      )[0].n;
      check(
        `S2 the ledger is EMPTY in the fixture window ${DAY} ET (exact expectations below depend on it)`,
        Number(pre) === 0,
        `${pre} pre-existing rows — move DAY to an unused date`,
      );
      if (Number(pre) !== 0) throw new Rollback();

      const phoneId =
        (
          (await tx.execute(sql`
            SELECT id FROM provider_phones WHERE org_id = ${orgId}::uuid ORDER BY id LIMIT 1
          `)) as unknown as { id: number }[]
        )[0]?.id ?? null;

      // ── fixtures ────────────────────────────────────────────────────────────
      const tag = `p3t4-${Date.now()}`;
      const campId = Number(
        (
          (await tx.execute(sql`
            INSERT INTO campaigns (org_id, slug, name, status)
            VALUES (${orgId}::uuid, ${tag}, ${`${tag} camp`}, 'draft')
            RETURNING id
          `)) as unknown as { id: number }[]
        )[0].id,
      );
      const stageId = Number(
        (
          (await tx.execute(sql`
            INSERT INTO campaign_stages (org_id, campaign_id, stage_number, provider_phone_id)
            VALUES (${orgId}::uuid, ${campId}::int, 1, ${phoneId})
            RETURNING id
          `)) as unknown as { id: number }[]
        )[0].id,
      );

      const roles = [
        "ledger_only",
        "legacy_only",
        "rejected_ledger",
        "two_conversions",
        "unmapped",
        "unmapped_status_only",
        "mapped_status_null",
        "registration_0",
      ] as const;
      type Role = (typeof roles)[number];
      const cid: Record<string, string> = {};
      const send: Record<string, string> = {};

      for (const [i, role] of roles.entries()) {
        cid[role] = (
          (await tx.execute(sql`
            INSERT INTO contacts (org_id, phone_number)
            VALUES (${orgId}::uuid, ${`+1213${String(Date.now()).slice(-6)}${i}`})
            RETURNING id::text AS id
          `)) as unknown as { id: string }[]
        )[0].id;
      }

      // The LEGACY columns per fixture — exactly what the old poll-conversions
      // writer would have left behind for that conversion (latest wins).
      const legacy: Record<Role, { status: string | null; revenue: string | null; converted: string | null }> = {
        ledger_only: { status: null, revenue: null, converted: null },
        legacy_only: { status: "lead", revenue: "100.0000", converted: et("09:00:00") },
        rejected_ledger: { status: null, revenue: null, converted: et("09:20:00") },
        // Latest wins kept only the SECOND payout, and the re-post moved the
        // stamp into the NEXT ET day.
        two_conversions: { status: "lead", revenue: "12.0000", converted: "2027-06-16 02:00:00-04" },
        unmapped: { status: "lead", revenue: "55.0000", converted: et("09:25:00") },
        unmapped_status_only: { status: "lead", revenue: "66.0000", converted: et("09:40:00") },
        // The old writer stamped Keitaro's raw status; the ledger's NULL status
        // has no legacy counterpart, so the column still read it as a paid lead
        // ('held' would not even satisfy stage_sends_sale_status_check).
        mapped_status_null: { status: "lead", revenue: "88.0000", converted: et("09:50:00") },
        registration_0: { status: "lead", revenue: "0.0000", converted: et("10:00:00") },
      };

      for (const role of roles) {
        const l = legacy[role];
        send[role] = (
          (await tx.execute(sql`
            INSERT INTO stage_sends
              (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status,
               sent_at, sale_status, sale_revenue, converted_at)
            VALUES (${orgId}::uuid, ${campId}::int, ${stageId}::int, ${cid[role]}::uuid,
                    ${`+1${role}`}, 'probe', 'sent', now(),
                    ${l.status},
                    ${l.revenue}::numeric,
                    ${l.converted}::timestamptz)
            RETURNING id::text AS id
          `)) as unknown as { id: string }[]
        )[0].id;
      }

      const mkEvent = async (args: {
        key: string;
        sendId: string;
        typeId: number | null;
        status: string | null;
        revenue: string;
        occurredAt: string;
        keitaroType?: string;
        keitaroStatus?: string;
      }) => {
        await tx.execute(sql`
          INSERT INTO conversion_events
            (org_id, keitaro_event_id, keitaro_status, keitaro_type, event_type_id, status,
             revenue, occurred_at, stage_send_id, contact_id, campaign_id, stage_id)
          VALUES (${orgId}::uuid, ${`${tag}-${args.key}`}, ${args.keitaroStatus ?? "lead"}, ${args.keitaroType ?? "lead"},
                  ${args.typeId}, ${args.status},
                  ${args.revenue}::numeric, ${args.occurredAt}::timestamptz,
                  ${args.sendId}::uuid, NULL, ${campId}::int, ${stageId}::int)
        `);
      };
      await mkEvent({ key: "a", sendId: send.ledger_only, typeId: purchaseTypeId, status: "approved", revenue: "42.0000", occurredAt: et("09:15:00") });
      await mkEvent({ key: "b", sendId: send.rejected_ledger, typeId: purchaseTypeId, status: "rejected", revenue: "77.0000", occurredAt: et("09:20:00") });
      await mkEvent({ key: "c1", sendId: send.two_conversions, typeId: purchaseTypeId, status: "approved", revenue: "30.0000", occurredAt: et("09:30:00") });
      await mkEvent({ key: "c2", sendId: send.two_conversions, typeId: purchaseTypeId, status: "approved", revenue: "12.0000", occurredAt: et("21:45:00") });
      // UNMAPPED shape (a): no mapping rule matched, so event_type_id AND status are NULL.
      await mkEvent({ key: "d", sendId: send.unmapped, typeId: null, status: null, revenue: "55.0000", occurredAt: et("09:25:00"), keitaroType: "upsell" });
      // UNMAPPED shape (b): a STATUS-ONLY rule — event_type_id NULL, status SET.
      // Real money with a real lifecycle status and no event type to place it.
      await mkEvent({ key: "d2", sendId: send.unmapped_status_only, typeId: null, status: "approved", revenue: "66.0000", occurredAt: et("09:40:00"), keitaroType: "upsell" });
      // A MAPPED purchase whose status did not map (unrecognised Keitaro status
      // on an already-mapped event; event_type_id is sticky, status is not).
      await mkEvent({ key: "d3", sendId: send.mapped_status_null, typeId: purchaseTypeId, status: null, revenue: "88.0000", occurredAt: et("09:50:00"), keitaroType: "sale", keitaroStatus: "held" });
      await mkEvent({ key: "e", sendId: send.registration_0, typeId: registrationTypeId, status: "approved", revenue: "0.0000", occurredAt: et("10:00:00"), keitaroType: "registration" });

      const ids = roles.map((r) => send[r]);
      const idsArr = sql`ARRAY[${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )}]::uuid[]`;

      // ── A. the shared per-send purchase/revenue aggregation ─────────────────
      // The REAL purchasesBySendSelect — the one text the partner report's
      // `purchases` CTE and the rollup's `conv_sends` CTE are both built from.
      console.log("\nA. purchasesBySendSelect + the rollup's real aggregate");
      type AggRow = { stage_send_id: string; purchases: number; revenue: string };
      const newAgg = (await tx.execute(sql`
        SELECT p.stage_send_id::text AS stage_send_id, p.purchases, p.revenue::text AS revenue
        FROM (${purchasesBySendSelect(orgId)}) p
        WHERE p.stage_send_id = ANY(${idsArr})
      `)) as unknown as AggRow[];
      const byId = new Map(newAgg.map((r) => [r.stage_send_id, r]));
      const expectAgg = (label: string, role: Role, purchases: number, revenue: number) =>
        check(
          label,
          byId.get(send[role])?.purchases === purchases && money(byId.get(send[role])?.revenue) === revenue,
          JSON.stringify(byId.get(send[role]) ?? null),
        );
      expectAgg("A1 NEW: ledger_only = 1 purchase / $42", "ledger_only", 1, 42);
      expectAgg("A2 ⭐ NEW: two_conversions = 2 purchases / $42 — BOTH count (+$715 class)", "two_conversions", 2, 42);
      // A3 is NOT the bare "0 purchases / $0" it used to be: the OLD reader read
      // 0/0 here too (sale_status is NULL on this fixture), so that assertion
      // discriminated nothing — it would have passed before and after the switch.
      // What IS new-code-specific: the rejected row is PRESENT in the group and
      // contributes nothing, i.e. it is dropped by its STATUS and not by absence.
      const rejRow = (
        (await tx.execute(sql`
          SELECT ce.status, ce.revenue::text AS revenue FROM conversion_events ce
          WHERE ce.org_id = ${orgId}::uuid AND ce.stage_send_id = ${send.rejected_ledger}::uuid
        `)) as unknown as { status: string | null; revenue: string }[]
      )[0];
      check(
        "A3 NEW: the $77 REJECTED row is in the group and contributes 0 purchases / $0 — dropped by status, not by absence",
        rejRow?.status === "rejected" &&
          money(rejRow.revenue) === 77 &&
          byId.has(send.rejected_ledger) &&
          byId.get(send.rejected_ledger)?.purchases === 0 &&
          money(byId.get(send.rejected_ledger)?.revenue) === 0,
        `${JSON.stringify(rejRow ?? null)} | ${JSON.stringify(byId.get(send.rejected_ledger) ?? null)}`,
      );
      expectAgg("A4 ⭐ NEW: unmapped shape (a), both columns NULL = 0 purchases / $0 (a class that SHRINKS a number)", "unmapped", 0, 0);
      expectAgg(
        "A4b ⭐ NEW: unmapped shape (b), status-only rule (event_type_id NULL, status='approved') = 0 purchases / $0",
        "unmapped_status_only",
        0,
        0,
      );
      expectAgg(
        "A4c ⭐ NEW: a MAPPED purchase type with a NULL status = 0 purchases / $0 (every clause needs a status)",
        "mapped_status_null",
        0,
        0,
      );
      // Revenue AND pending revenue, at the same grain, from the real clauses.
      // WORLD STATE: no fixture is pending, so the pending set is expected EMPTY
      // — which alone would be vacuous, so the identical query with
      // approvedRevenueClause is the positive control: it must return the two
      // revenue-bearing sends.
      const revenueBySend = async (clause: ReturnType<typeof sql>) =>
        (await tx.execute(sql`
          SELECT ce.stage_send_id::text AS stage_send_id, sum(ce.revenue)::text AS revenue
          FROM conversion_events ce
          WHERE ce.org_id = ${orgId}::uuid AND ce.stage_send_id = ANY(${idsArr}) AND ${clause}
          GROUP BY 1
        `)) as unknown as { stage_send_id: string; revenue: string }[];
      const approvedRev = await revenueBySend(approvedRevenueClause());
      const pendingRev = await revenueBySend(pendingRevenueClause());
      const approvedIds = new Set(approvedRev.map((r) => r.stage_send_id));
      check(
        "A4d ⭐ NEW: neither unmapped shape nor the NULL-status purchase is in APPROVED or PENDING revenue (control: approved = the 2 real payouts, pending = none)",
        approvedRev.length === 2 &&
          approvedIds.has(send.ledger_only) &&
          approvedIds.has(send.two_conversions) &&
          pendingRev.length === 0 &&
          !approvedIds.has(send.unmapped) &&
          !approvedIds.has(send.unmapped_status_only) &&
          !approvedIds.has(send.mapped_status_null),
        `approved=${JSON.stringify(approvedRev)} pending=${JSON.stringify(pendingRev)}`,
      );
      expectAgg("A5 ⭐ NEW: registration_0 = 0 purchases / $0", "registration_0", 0, 0);
      check("A6 NEW: legacy_only has no ledger row — absent from the aggregate", !byId.has(send.legacy_only));

      // The `restrict` bound the two call sites now pass must be INERT: it may
      // only drop rows their own join would discard.
      const bounded = (await tx.execute(sql`
        SELECT p.stage_send_id::text AS stage_send_id, p.purchases, p.revenue::text AS revenue
        FROM (${purchasesBySendSelect(
          orgId,
          sql`AND ce.stage_send_id = ANY(${idsArr})`,
        )}) p
      `)) as unknown as AggRow[];
      check(
        "A7 ⭐ the new `restrict` bound changes nothing it is given rows for (same purchases + revenue)",
        bounded.length === newAgg.length &&
          bounded.every(
            (r) =>
              byId.get(r.stage_send_id)?.purchases === r.purchases &&
              money(byId.get(r.stage_send_id)?.revenue) === money(r.revenue),
          ),
        JSON.stringify(bounded),
      );

      // The rollup's REAL exported aggregate, end to end (sentCte → conv_sends →
      // the hour bucket), filtered to the fixture stage.
      const rollupRows = (await tx.execute(sql`
        SELECT sum(agg.sent_count)::int AS sent_count,
               sum(agg.sales_count)::int AS sales_count,
               sum(agg.revenue)::text AS revenue
        FROM (${stageHourAggregate(sql`now() - interval '10 minutes'`)}) agg
        WHERE agg.stage_id = ${stageId}::int
      `)) as unknown as { sent_count: number; sales_count: number; revenue: string }[];
      check(
        "A8 ⭐ NEW: the REAL rollup aggregate reads sent=8, sales=3, revenue=$84 for the fixture stage",
        Number(rollupRows[0]?.sent_count) === 8 &&
          Number(rollupRows[0]?.sales_count) === 3 &&
          money(rollupRows[0]?.revenue) === 84,
        JSON.stringify(rollupRows[0] ?? null),
      );

      // RED PROOF — the pre-switch reads, retyped (that code is gone).
      const oldAgg = (await tx.execute(sql`
        SELECT ss.id::text AS id,
               (coalesce(ss.sale_status IN ('lead', 'sale'), false))::int AS purchased,
               coalesce(ss.sale_revenue, 0)::text AS revenue,
               (ss.converted_at IS NOT NULL)::int AS converted
        FROM stage_sends ss
        WHERE ss.id = ANY(${idsArr})
      `)) as unknown as { id: string; purchased: number; revenue: string; converted: number }[];
      const oldById = new Map(oldAgg.map((r) => [r.id, r]));
      check(
        "A9 RED PROOF — OLD (ss.sale_status/sale_revenue) MISSED ledger_only's real $42 purchase",
        oldById.get(send.ledger_only)?.purchased === 0 && money(oldById.get(send.ledger_only)?.revenue) === 0,
        JSON.stringify(oldById.get(send.ledger_only)),
      );
      check(
        "A10 RED PROOF — OLD counted two_conversions as ONE $12 sale: the first $30 payout was overwritten",
        oldById.get(send.two_conversions)?.purchased === 1 &&
          money(oldById.get(send.two_conversions)?.revenue) === 12,
        JSON.stringify(oldById.get(send.two_conversions)),
      );
      check(
        "A11 ⭐ RED PROOF — OLD counted the UNMAPPED row as a $55 sale (this is the number that shrinks)",
        oldById.get(send.unmapped)?.purchased === 1 && money(oldById.get(send.unmapped)?.revenue) === 55,
        JSON.stringify(oldById.get(send.unmapped)),
      );
      check(
        "A11b ⭐ RED PROOF — OLD counted the STATUS-ONLY unmapped row as a $66 sale, and its status column looked perfectly normal ('lead')",
        oldById.get(send.unmapped_status_only)?.purchased === 1 &&
          money(oldById.get(send.unmapped_status_only)?.revenue) === 66,
        JSON.stringify(oldById.get(send.unmapped_status_only)),
      );
      check(
        "A11c ⭐ RED PROOF — OLD read the NULL-status purchase as a $88 sale and stamped converted_at (so the old ROLLUP counted it too — see A14)",
        oldById.get(send.mapped_status_null)?.purchased === 1 &&
          oldById.get(send.mapped_status_null)?.converted === 1 &&
          money(oldById.get(send.mapped_status_null)?.revenue) === 88,
        JSON.stringify(oldById.get(send.mapped_status_null)),
      );
      check(
        "A12 ⭐ RED PROOF — OLD counted the $0 REGISTRATION as a sale (a registrant read as a buyer)",
        oldById.get(send.registration_0)?.purchased === 1,
        JSON.stringify(oldById.get(send.registration_0)),
      );
      check(
        "A13 RED PROOF — OLD counted legacy_only as a $100 sale with no ledger row behind it",
        oldById.get(send.legacy_only)?.purchased === 1 && money(oldById.get(send.legacy_only)?.revenue) === 100,
        JSON.stringify(oldById.get(send.legacy_only)),
      );
      const oldRollup = (await tx.execute(sql`
        SELECT count(*) FILTER (WHERE ss.converted_at IS NOT NULL)::int AS sales_count,
               coalesce(sum(ss.sale_revenue) FILTER (WHERE ss.converted_at IS NOT NULL), 0)::text AS revenue
        FROM stage_sends ss WHERE ss.id = ANY(${idsArr})
      `)) as unknown as { sales_count: number; revenue: string }[];
      check(
        "A14 RED PROOF — the OLD rollup expressions read sales=7, revenue=$321 over the same eight sends (truth: 3 / $84)",
        Number(oldRollup[0].sales_count) === 7 && money(oldRollup[0].revenue) === 321,
        JSON.stringify(oldRollup[0]),
      );

      // ── B. the real `sale` weight-basis candidate set ───────────────────────
      console.log("\nB. saleWeightCandidates (performance-report.ts, the real export)");
      const cand = (await tx.execute(sql`
        SELECT c.contact_id::text AS contact_id, count(*)::int AS rows
        FROM (${saleWeightCandidates(orgId, [stageId])}) c
        GROUP BY 1
      `)) as unknown as { contact_id: string; rows: number }[];
      const candByContact = new Map(cand.map((r) => [r.contact_id, Number(r.rows)]));
      check("B1 NEW: ledger_only's contact IS a sale-weight candidate", candByContact.has(cid.ledger_only));
      check(
        "B2 ⭐ NEW: two_conversions' contact appears EXACTLY ONCE — weights are per CONTACT, not per event",
        candByContact.get(cid.two_conversions) === 1,
        JSON.stringify([...candByContact.entries()]),
      );
      check("B3 NEW: legacy_only is not a candidate", !candByContact.has(cid.legacy_only));
      check("B4 NEW: rejected_ledger is not a candidate", !candByContact.has(cid.rejected_ledger));
      check("B5 ⭐ NEW: unmapped shape (a) is not a candidate", !candByContact.has(cid.unmapped));
      check(
        "B5b ⭐ NEW: unmapped shape (b) — status 'approved', no event type — is NOT a sale-weight candidate",
        !candByContact.has(cid.unmapped_status_only),
        JSON.stringify([...candByContact.entries()]),
      );
      check(
        "B5c ⭐ NEW: the NULL-status purchase is NOT a candidate",
        !candByContact.has(cid.mapped_status_null),
      );
      check("B6 ⭐ NEW: registration_0 is not a candidate", !candByContact.has(cid.registration_0));
      const oldCand = new Set(
        (
          (await tx.execute(sql`
            SELECT ss.contact_id::text AS contact_id FROM stage_sends ss
            WHERE ss.org_id = ${orgId}::uuid AND ss.converted_at IS NOT NULL
              AND ss.stage_id = ${stageId}::int
          `)) as unknown as { contact_id: string }[]
        ).map((r) => r.contact_id),
      );
      check(
        "B7 RED PROOF — the OLD basis (ss.converted_at) missed ledger_only and included all six non-buyers",
        !oldCand.has(cid.ledger_only) &&
          oldCand.has(cid.legacy_only) &&
          oldCand.has(cid.rejected_ledger) &&
          oldCand.has(cid.unmapped) &&
          oldCand.has(cid.unmapped_status_only) &&
          oldCand.has(cid.mapped_status_null) &&
          oldCand.has(cid.registration_0),
        JSON.stringify([...oldCand]),
      );

      // ── C. Rule F — the real rescue set AND the real rebuild ────────────────
      console.log("\nC. Rule F (rescueSendIds + the real refreshCountedClickers)");
      const rescued = (await tx.execute(sql`
        SELECT r.stage_send_id::text AS stage_send_id,
               to_char(r.first_event_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS first_event_et
        FROM (${rescueSendIds(null)}) r
        WHERE r.stage_send_id = ANY(${idsArr})
      `)) as unknown as { stage_send_id: string; first_event_et: string }[];
      const rescuedById = new Map(rescued.map((r) => [r.stage_send_id, r]));
      check("C1 NEW: ledger_only IS rescued (a counted purchase)", rescuedById.has(send.ledger_only));
      check(
        "C2 ⭐ NEW: two_conversions is rescued ONCE, stamped with its EARLIEST event (09:30 ET, not 21:45)",
        rescuedById.has(send.two_conversions) &&
          rescued.filter((r) => r.stage_send_id === send.two_conversions).length === 1 &&
          rescuedById.get(send.two_conversions)?.first_event_et === `${DAY} 09:30`,
        JSON.stringify(rescuedById.get(send.two_conversions) ?? null),
      );
      check("C3 NEW: legacy_only is NOT rescued (no ledger row)", !rescuedById.has(send.legacy_only));
      check("C4 NEW: rejected_ledger is NOT rescued", !rescuedById.has(send.rejected_ledger));
      check("C5 ⭐ NEW: the UNMAPPED row (shape a) is NOT rescued", !rescuedById.has(send.unmapped));
      check(
        "C5b ⭐ NEW: the STATUS-ONLY unmapped row (shape b) is NOT rescued — 'approved' alone does not earn a denominator seat",
        !rescuedById.has(send.unmapped_status_only),
        JSON.stringify(rescued.map((r) => r.stage_send_id)),
      );
      check(
        "C5c ⭐ NEW: the NULL-status purchase is NOT rescued",
        !rescuedById.has(send.mapped_status_null),
      );
      check(
        "C6 ⭐ NEW: the $0 registration is NOT rescued (neither a purchase nor revenue)",
        !rescuedById.has(send.registration_0),
      );

      // The REAL rebuild, writing real rows in this transaction. Incremental
      // mode, so it exercises the updated_at window too and takes no DELETE.
      const refresh = await refreshCountedClickers(tx, "incremental");
      const cc = (await tx.execute(sql`
        SELECT cc.contact_id::text AS contact_id, cc.rescued_by_conversion,
               to_char(cc.first_click_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS first_click_et
        FROM counted_clickers cc WHERE cc.stage_id = ${stageId}::int
      `)) as unknown as { contact_id: string; rescued_by_conversion: boolean; first_click_et: string }[];
      const ccByContact = new Map(cc.map((r) => [r.contact_id, r]));
      check(
        "C7 ⭐ NEW: the REAL rebuild wrote exactly the two rescue-eligible recipients into counted_clickers",
        cc.length === 2 &&
          ccByContact.has(cid.ledger_only) &&
          ccByContact.has(cid.two_conversions) &&
          [...ccByContact.values()].every((r) => r.rescued_by_conversion === true),
        `${refresh.mode} rows=${refresh.rows} rescued=${refresh.rescuedByConversion}: ${JSON.stringify(cc)}`,
      );
      check(
        "C8 ⭐ NEW: no row for rejected / either unmapped shape / NULL-status / registration / legacy-only — the denominator is not inflated",
        !ccByContact.has(cid.rejected_ledger) &&
          !ccByContact.has(cid.unmapped) &&
          !ccByContact.has(cid.unmapped_status_only) &&
          !ccByContact.has(cid.mapped_status_null) &&
          !ccByContact.has(cid.registration_0) &&
          !ccByContact.has(cid.legacy_only),
        JSON.stringify(cc),
      );
      check(
        "C9 NEW: a rescued row with no click falls back to the conversion's own time",
        ccByContact.get(cid.two_conversions)?.first_click_et === `${DAY} 09:30`,
        JSON.stringify(ccByContact.get(cid.two_conversions) ?? null),
      );
      const oldRescue = new Set(
        (
          (await tx.execute(sql`
            SELECT ss.id::text AS id FROM stage_sends ss
            WHERE ss.converted_at IS NOT NULL AND ss.id = ANY(${idsArr})
          `)) as unknown as { id: string }[]
        ).map((r) => r.id),
      );
      check(
        "C10 ⭐ RED PROOF — the OLD rescue (ss.converted_at) missed ledger_only and rescued rejected + both unmapped shapes + the NULL-status row + the $0 registration",
        !oldRescue.has(send.ledger_only) &&
          oldRescue.has(send.rejected_ledger) &&
          oldRescue.has(send.unmapped) &&
          oldRescue.has(send.unmapped_status_only) &&
          oldRescue.has(send.mapped_status_null) &&
          oldRescue.has(send.registration_0),
        JSON.stringify([...oldRescue]),
      );

      // ── D. the real hourly query ────────────────────────────────────────────
      // ledgerHourQuery, with its ET hour bucketing, its occurred_at range and
      // its provider filter — the parts the first version of this block dropped.
      console.log("\nD. ledgerHourQuery (the real hourly text: bucket + range + provider filter)");
      const hours = async (args: {
        from?: string;
        to?: string;
        providerPhoneId?: number | null;
        value: "sales" | "revenue";
      }) => {
        const rows = (await tx.execute(
          ledgerHourQuery({
            orgId,
            from: args.from ?? DAY,
            to: args.to ?? DAY,
            providerPhoneId: args.providerPhoneId,
            // The same clauses getHourlyReport passes — not a retyped pair.
            where: args.value === "sales" ? purchasedClause() : approvedRevenueClause(),
            valueExpr:
              args.value === "sales" ? sql`count(*)::int` : sql`coalesce(sum(ce.revenue), 0)::float8`,
          }),
        )) as unknown as { hour: number; v: number }[];
        return Object.fromEntries(rows.map((r) => [Number(r.hour), money(r.v)])) as Record<number, number>;
      };
      const salesByHour = await hours({ value: "sales" });
      const revenueByHour = await hours({ value: "revenue" });
      check(
        "D1 ⭐ NEW: sales bucket by the CONVERSION's ET hour — {9: 2, 21: 1}",
        JSON.stringify(salesByHour) === JSON.stringify({ 9: 2, 21: 1 }),
        JSON.stringify(salesByHour),
      );
      check(
        "D2 ⭐ NEW: revenue buckets {9: $72, 21: $12} — approved only, the $77 rejected and $55 unmapped excluded",
        JSON.stringify(revenueByHour) === JSON.stringify({ 9: 72, 21: 12 }),
        JSON.stringify(revenueByHour),
      );
      check(
        "D3 ⭐ NEW: the occurred_at range EXCLUDES the day after — the fixtures do not leak into 2027-06-16",
        Object.keys(await hours({ from: "2027-06-16", to: "2027-06-16", value: "sales" })).length === 0,
      );
      check(
        "D4 NEW: a wider range still finds all three purchases",
        JSON.stringify(await hours({ from: "2027-06-14", to: "2027-06-16", value: "sales" })) ===
          JSON.stringify({ 9: 2, 21: 1 }),
      );
      if (phoneId == null) {
        check(
          "D5 the provider filter could NOT be exercised — this preview DB has no provider_phones row",
          false,
          "seed one provider phone on the preview org to restore this check",
        );
      } else {
        check(
          "D5 ⭐ NEW: the provider filter passes the fixture stage's own number through",
          JSON.stringify(await hours({ providerPhoneId: phoneId, value: "sales" })) ===
            JSON.stringify({ 9: 2, 21: 1 }),
        );
        check(
          "D6 ⭐ NEW: the provider filter EXCLUDES a different number (the filter is really applied)",
          Object.keys(await hours({ providerPhoneId: -1, value: "sales" })).length === 0,
        );
      }
      // RED PROOF for correction class D — the instant changed, and it moves a
      // number TODAY. The old basis was stage_sends.converted_at, Keitaro's
      // LATEST re-post time: two_conversions' re-post pushed its stamp into the
      // next ET day, so the old hourly dropped $42 out of this day entirely and
      // placed the other four sends by a time that had already moved once.
      const oldHours = (await tx.execute(sql`
        SELECT EXTRACT(HOUR FROM ss.converted_at AT TIME ZONE 'America/New_York')::int AS hour,
               count(*)::int AS sales,
               coalesce(sum(ss.sale_revenue), 0)::float8 AS revenue
        FROM stage_sends ss
        WHERE ss.org_id = ${orgId}::uuid
          AND ss.converted_at >= ${ET_DAY_START}::timestamptz
          AND ss.converted_at < ${ET_DAY_END}::timestamptz
          AND ss.id = ANY(${idsArr})
        GROUP BY 1
      `)) as unknown as { hour: number; sales: number; revenue: number }[];
      const oldByHour = Object.fromEntries(oldHours.map((r) => [Number(r.hour), money(r.revenue)]));
      check(
        "D7 ⭐ RED PROOF — the OLD hourly placed $309 in hour 9 + $0 in hour 10 and LOST two_conversions' $42 to the next day (correction class D)",
        JSON.stringify(oldByHour) === JSON.stringify({ 9: 309, 10: 0 }) &&
          oldHours.reduce((a, r) => a + Number(r.sales), 0) === 6,
        JSON.stringify(oldHours),
      );
      check(
        "D8 ⭐ the NEW instant cannot move: occurred_at is the conversion's own time, and a re-post only touches last_postback_at",
        render(
          ledgerHourQuery({ orgId, from: DAY, to: DAY, where: sql`true`, valueExpr: sql`count(*)::int` }),
        ).includes("EXTRACT(HOUR FROM ce.occurred_at AT TIME ZONE 'America/New_York')"),
      );

      // ── E. the real activity-badge LATERAL + the real badge rendering ───────
      console.log("\nE. latestConversionForSend + lib/conversion-badge (the real badge decisions)");
      type BadgeRow = {
        id: string;
        conversion_event: string | null;
        conversion_status: string | null;
        conversion_revenue: string | null;
        conversion_is_purchase: boolean | null;
      };
      const badge = (await tx.execute(sql`
        SELECT ss.id::text AS id,
               conv.event_label AS conversion_event,
               conv.status AS conversion_status,
               conv.revenue AS conversion_revenue,
               conv.is_purchase AS conversion_is_purchase
        FROM stage_sends ss
        LEFT JOIN LATERAL (${latestConversionForSend("ss")}) conv ON true
        WHERE ss.id = ANY(${idsArr})
      `)) as unknown as BadgeRow[];
      const badgeById = new Map(badge.map((r) => [r.id, r]));
      const row = (role: Role) => badgeById.get(send[role])!;
      check(
        "E1 NEW: ledger_only → Purchase · approved · $42, is_purchase=true",
        row("ledger_only").conversion_event === "Purchase" &&
          row("ledger_only").conversion_status === "approved" &&
          money(row("ledger_only").conversion_revenue) === 42 &&
          row("ledger_only").conversion_is_purchase === true,
        JSON.stringify(row("ledger_only")),
      );
      check(
        "E2 ⭐ NEW: two_conversions shows the LATEST event ($12 at 21:45), not the first",
        money(row("two_conversions").conversion_revenue) === 12,
        JSON.stringify(row("two_conversions")),
      );
      check("E3 NEW: legacy_only shows no badge at all", row("legacy_only").conversion_event == null);
      check(
        "E4 NEW: rejected_ledger shows Purchase · rejected",
        row("rejected_ledger").conversion_status === "rejected",
        JSON.stringify(row("rejected_ledger")),
      );
      check(
        "E5 ⭐ NEW: the UNMAPPED row shows its raw Keitaro type with a NULL status and NULL is_purchase",
        row("unmapped").conversion_event === "upsell" &&
          row("unmapped").conversion_status == null &&
          row("unmapped").conversion_is_purchase == null,
        JSON.stringify(row("unmapped")),
      );
      check(
        "E5b ⭐ NEW: unmapped shape (b) shows its raw Keitaro type with status 'approved' and a NULL is_purchase",
        row("unmapped_status_only").conversion_event === "upsell" &&
          row("unmapped_status_only").conversion_status === "approved" &&
          row("unmapped_status_only").conversion_is_purchase == null,
        JSON.stringify(row("unmapped_status_only")),
      );
      check(
        "E5c ⭐ NEW: the NULL-status purchase shows its MAPPED label with a NULL status and is_purchase=true",
        row("mapped_status_null").conversion_event === "Purchase" &&
          row("mapped_status_null").conversion_status == null &&
          row("mapped_status_null").conversion_is_purchase === true,
        JSON.stringify(row("mapped_status_null")),
      );
      check(
        "E6 ⭐ NEW: the $0 registration shows Registration · approved with is_purchase=false",
        row("registration_0").conversion_event === "Registration" &&
          row("registration_0").conversion_status === "approved" &&
          row("registration_0").conversion_is_purchase === false &&
          money(row("registration_0").conversion_revenue) === 0,
        JSON.stringify(row("registration_0")),
      );
      check(
        "E7 the LATERAL is org-scoped (ce.org_id = ss.org_id), not stage_send_id alone",
        render(latestConversionForSend("ss")).includes("ce.org_id = ss.org_id"),
        render(latestConversionForSend("ss")),
      );

      // The REAL rendering decisions, on the rows just read.
      check(
        "E8 ⭐ NEW: the $0 registration is NOT painted purchase-green",
        conversionBadgeClass(row("registration_0")) === CONVERSION_SIGNAL_STYLE &&
          conversionBadgeClass(row("registration_0")) !== CONVERSION_STATUS_STYLES.approved,
        conversionBadgeClass(row("registration_0")),
      );
      check(
        "E9 ⭐ NEW: the $0 registration prints NO money",
        conversionAmount(row("registration_0")) === null,
        String(conversionAmount(row("registration_0"))),
      );
      // The pre-switch cell, retyped: colour keyed on status ALONE, and the
      // tooltip's money gated on the truthiness of the revenue STRING.
      const oldClass = (r: BadgeRow) => CONVERSION_STATUS_STYLES[r.conversion_status ?? ""] ?? "";
      const oldMoney = (r: BadgeRow) =>
        r.conversion_revenue ? `$${Number(r.conversion_revenue).toFixed(2)}` : "";
      check(
        "E10 ⭐ RED PROOF — the OLD cell painted the $0 registration the SAME emerald as a paid sale, and printed '· $0.00'",
        oldClass(row("registration_0")) === oldClass(row("ledger_only")) &&
          oldMoney(row("registration_0")) === "$0.00" &&
          conversionBadgeClass(row("registration_0")) !== conversionBadgeClass(row("ledger_only")),
        `${oldClass(row("registration_0"))} | ${oldMoney(row("registration_0"))}`,
      );
      // An unmapped row DOES print its amount, deliberately: it is real money
      // Keitaro reported that no report counts, and the neutral badge + the word
      // "unmapped" is what says so. Suppressing it would hide the thing the
      // Phase 2 unmapped alert exists to chase. It is LABELLED "uncounted",
      // because a bare "· $55.00" next to a neutral badge still reads as revenue.
      check(
        "E11 ⭐ NEW: the unmapped row gets the NEUTRAL badge and prints '· $55.00 uncounted', not a bare amount",
        conversionBadgeClass(row("unmapped")) === CONVERSION_UNMAPPED_STYLE &&
          conversionBadgeClass(row("unmapped")) !== CONVERSION_STATUS_STYLES.approved &&
          conversionAmount(row("unmapped")) === 55 &&
          conversionAmountLabel(row("unmapped")) === " · $55.00 uncounted",
        `${conversionBadgeClass(row("unmapped"))} | ${conversionAmountLabel(row("unmapped"))}`,
      );
      check(
        "E11b ⭐ NEW: shape (b) says 'approved' but has no event type — NEUTRAL badge, '· $66.00 uncounted'",
        conversionBadgeClass(row("unmapped_status_only")) === CONVERSION_UNMAPPED_STYLE &&
          conversionBadgeClass(row("unmapped_status_only")) !== CONVERSION_STATUS_STYLES.approved &&
          conversionAmountLabel(row("unmapped_status_only")) === " · $66.00 uncounted",
        `${conversionBadgeClass(row("unmapped_status_only"))} | ${conversionAmountLabel(row("unmapped_status_only"))}`,
      );
      check(
        "E11c ⭐ RED PROOF — the OLD cell painted shape (b) the SAME emerald as a paid sale and printed a bare '$66.00'",
        oldClass(row("unmapped_status_only")) === oldClass(row("ledger_only")) &&
          oldMoney(row("unmapped_status_only")) === "$66.00" &&
          conversionBadgeClass(row("unmapped_status_only")) !== conversionBadgeClass(row("ledger_only")),
        `${oldClass(row("unmapped_status_only"))} | ${oldMoney(row("unmapped_status_only"))}`,
      );
      check(
        "E11d ⭐ NEW: a MAPPED purchase with a NULL status gets a DEFINED distinct badge (not '', not a purchase/pending colour) and '· $88.00 uncounted'",
        conversionBadgeClass(row("mapped_status_null")) === CONVERSION_STATUS_UNKNOWN_STYLE &&
          conversionBadgeClass(row("mapped_status_null")) !== "" &&
          conversionBadgeClass(row("mapped_status_null")) !== CONVERSION_STATUS_STYLES.approved &&
          conversionBadgeClass(row("mapped_status_null")) !== CONVERSION_STATUS_STYLES.pending &&
          conversionBadgeClass(row("mapped_status_null")) !== CONVERSION_UNMAPPED_STYLE &&
          conversionAmountLabel(row("mapped_status_null")) === " · $88.00 uncounted",
        `${conversionBadgeClass(row("mapped_status_null"))} | ${conversionAmountLabel(row("mapped_status_null"))}`,
      );
      check(
        "E12 NEW: a real approved purchase keeps the approved colour and prints '· $42.00' with NO 'uncounted'",
        conversionBadgeClass(row("ledger_only")) === CONVERSION_STATUS_STYLES.approved &&
          conversionAmount(row("ledger_only")) === 42 &&
          conversionAmountLabel(row("ledger_only")) === " · $42.00",
        conversionAmountLabel(row("ledger_only")),
      );
      check(
        "E13 NEW: a rejected purchase is red and prints no money (it was taken back)",
        conversionBadgeClass(row("rejected_ledger")) === CONVERSION_STATUS_STYLES.rejected &&
          conversionAmount(row("rejected_ledger")) === null,
      );

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  check("Z1 the fixture transaction ran and rolled back", sawTx);

  // ── F. call-site guards for the three surfaces a rolled-back proof cannot
  // execute (getPartnerReport / trackedWeights / getHourlyReport all run against
  // the module-level `db`). These name a FILE, not a screen: they prove the call
  // site still goes through the fragment the blocks above proved, and nothing
  // more.
  //
  // AUDITED 2026-09-18 for the "can never fail" defect class: every needle below
  // is single-line (F5's was not — see the header), and each NEGATED needle is a
  // string the PRE-switch code really contained, so restoring that code turns the
  // check red. F6's `ss.converted_at IS NOT NULL` was line 188 of the old
  // counted-clickers.ts, and the module's surviving comments say
  // "stage_sends.converted_at IS NOT NULL", which this needle does not match.
  console.log("\nF. call-site guards (weak by construction — see the header)");
  const src = (p: string) => readFileSync(p, "utf8");
  // Whitespace-collapsed source. EVERY needle below must be single-line, or it
  // must go through this: the checkout is CRLF, so a literal containing "\n"
  // matches nothing — and in a NEGATED assertion that is a check which can never
  // fail. See the header.
  const flat = (p: string) => src(p).replace(/\s+/g, " ");
  check(
    "F1 partner-report.ts builds its `purchases` CTE from purchasesBySendSelect",
    src("lib/reporting/partner-report.ts").includes("purchases AS (${purchasesBySendSelect("),
  );
  check(
    "F2 rollup.ts builds `conv_sends` from the same helper",
    src("lib/reporting/rollup.ts").includes("purchasesBySendSelect("),
  );
  check(
    "F3 performance-report.ts's sale basis calls saleWeightCandidates and its hourly calls ledgerHourQuery",
    src("lib/reporting/performance-report.ts").includes("? saleWeightCandidates(orgId, stageIds)") &&
      src("lib/reporting/performance-report.ts").includes("ledgerHourQuery({"),
  );
  check(
    "F4 the activity route's LATERAL is latestConversionForSend",
    src("app/api/campaigns/[campaignId]/activity/messages/route.ts").includes(
      "LEFT JOIN LATERAL (${latestConversionForSend(\"ss\")}) conv ON true",
    ),
  );
  // The negative half is a REGEX over the flattened source, not a multi-line
  // literal (which could never match a CRLF file, so restoring the old inline map
  // verbatim kept this check green). Two independent tells of a re-inlined copy:
  //   • a CONVERSION_* style constant declared in the .tsx, and
  //   • "bg-red-100 text-red-700" — the conversion map's own rejected colour. The
  //     SEND-status map right above it uses text-red-800, so this pair belongs to
  //     the conversion copy alone. (A bare /bg-(emerald|amber|sky|slate)-\d00/
  //     would match that send-status map and be permanently RED — checked.)
  const activityTsx = "components/campaigns/campaign-activity-section.tsx";
  check(
    "F5 the activity cell renders through lib/conversion-badge (no second copy in the .tsx)",
    src(activityTsx).includes('from "@/lib/conversion-badge"') &&
      src(activityTsx).includes("conversionBadgeClass(r)") &&
      !/const\s+CONVERSION_[A-Z_]+\s*(:|=)/.test(flat(activityTsx)) &&
      !/bg-red-100 text-red-700/.test(flat(activityTsx)),
    flat(activityTsx).match(/const CONVERSION_[A-Z_]+|bg-red-100 text-red-700/g)?.join(" | ") ?? "",
  );
  check(
    "F6 counted-clickers.ts rescues through rescueSendIds, not a converted_at predicate",
    src("lib/reporting/counted-clickers.ts").includes("rescueSendIds(null, convWindow)") &&
      !src("lib/reporting/counted-clickers.ts").includes("ss.converted_at IS NOT NULL"),
  );

  console.log(`\n${passed} passed, ${failed} failed  (transaction rolled back)`);
  await pgConn.end({ timeout: 5 });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
});
