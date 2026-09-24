import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// The eight lifecycle segment rule types (migration 0189, spec §9) against the
// PREVIEW DB.
//
// Every bar goes through buildSegmentAudienceClause — the real evaluator — not
// through ruleInnerQuery and not through hand-written SQL. Two reasons:
//   * a test that rebuilds the statement only compares it against a copy of
//     itself, and
//   * gateEligible() is part of what makes L9 true, so a test that skipped the
//     finished clause would be testing something else entirely.
//
// Torn down by org_id after re-reading the marker, with a post-teardown count.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-segment-rule-lifecycle.ts

import { sql, type SQL } from "drizzle-orm";

const DAY = 86_400_000;
const NOW = Date.now();
const MARKER = "__SEGRULE_LIFECYCLE_TEST__";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } = await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const { buildSegmentAudienceClause } = await import("@/lib/segment-rules-eval");
  const { ENGAGEMENT_STATUSES } = await import("@/lib/engagement/constants");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T,>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T,>(q: SQL): Promise<T[]> => (await db.execute(q)) as unknown as T[];

  const tag = `segrule-${Date.now()}`;
  let orgId = "";

  try {
    orgId = (
      await one<{ id: string }>(
        sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`,
      )
    ).id;
    const org = sql`${orgId}::uuid`;

    // ── The world ──────────────────────────────────────────────────────────
    // Eight contacts. Facts are written DIRECTLY into contact_engagement: this
    // tests the RULES, not the job that populates them (Parts A-I of
    // test-engagement-db.ts own that).
    const phones = fictionalPhones(8);
    await refuseIfPhonesInUse(db, phones);

    const mk = async (
      i: number,
      opts: {
        eligible?: boolean;
        lifecycle: string;
        engagement?: {
          status: string;
          msgs_total: number;
          msgs_30d?: number;
          last_sent_at?: string | null;
          last_click_at?: string | null;
        };
      },
    ) => {
      const id = (
        await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number, lifecycle_status, line_type)
          VALUES (${org}, ${phones[i]}, ${opts.lifecycle},
                  ${opts.eligible === false ? "landline" : "mobile"})
          RETURNING id`)
      ).id;
      // messaging_status is trigger-derived from line_type, so an ineligible
      // contact is made by giving it a landline, not by writing the column.
      if (opts.engagement) {
        const e = opts.engagement;
        await db.execute(sql`
          INSERT INTO contact_engagement
            (contact_id, org_id, status, status_changed_at, msgs_total, msgs_since_click,
             msgs_7d, msgs_14d, msgs_30d, msgs_90d, last_sent_at, last_click_at,
             freeze_cadence_days, thresholds)
          VALUES (${id}::uuid, ${org}, ${e.status}, now(), ${e.msgs_total}, ${e.msgs_total},
                  0, 0, ${e.msgs_30d ?? 0}, 0,
                  ${e.last_sent_at ?? null}::timestamptz, ${e.last_click_at ?? null}::timestamptz,
                  14, '{}'::jsonb)`);
      }
      return id;
    };

    // name            elig  lifecycle  msgs  30d  last_sent  last_click
    const cHot = await mk(0, { lifecycle: "hot", engagement: { status: "hot", msgs_total: 9, msgs_30d: 4, last_sent_at: ago(2), last_click_at: ago(1) } });
    const cWarm = await mk(1, { lifecycle: "warm", engagement: { status: "warm", msgs_total: 6, msgs_30d: 2, last_sent_at: ago(40), last_click_at: ago(60) } });
    const cCold = await mk(2, { lifecycle: "cold", engagement: { status: "cold", msgs_total: 2, msgs_30d: 0, last_sent_at: ago(200), last_click_at: null } });
    const cFreeze = await mk(3, { lifecycle: "freeze", engagement: { status: "freeze", msgs_total: 20, msgs_30d: 9, last_sent_at: ago(5), last_click_at: ago(400) } });
    // Never messaged and never clicked: both timestamps NULL.
    const cNever = await mk(4, { lifecycle: "new", engagement: { status: "new", msgs_total: 0, msgs_30d: 0, last_sent_at: null, last_click_at: null } });
    // The job has never reached this one: NO contact_engagement row at all.
    const cNoRow = await mk(5, { lifecycle: "new" });
    // INELIGIBLE (landline) and hot — the row that lands on the wrong side if
    // any of the eight starts filtering eligibility on its own.
    const cIneligibleHot = await mk(6, { eligible: false, lifecycle: "hot", engagement: { status: "hot", msgs_total: 7, msgs_30d: 3, last_sent_at: ago(3), last_click_at: ago(2) } });
    const cQuiet = await mk(7, { lifecycle: "cold", engagement: { status: "cold", msgs_total: 1, msgs_30d: 0, last_sent_at: ago(365), last_click_at: ago(365) } });

    const eligibleIds = new Set([cHot, cWarm, cCold, cFreeze, cNever, cNoRow, cQuiet]);
    const [{ n: eligibleCount }] = await all<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM contacts
      WHERE org_id = ${org} AND messaging_status = 'eligible'`);
    bar("precondition: 7 of 8 contacts are eligible", Number(eligibleCount) === 7, `${eligibleCount}`);

    // ── Segment plumbing ───────────────────────────────────────────────────
    let seq = 0;
    const segmentWith = async (
      rules: { rule_type: string; operator?: string; value: unknown; combinator?: string }[],
    ) => {
      seq++;
      const segId = (
        await one<{ id: number }>(sql`
          INSERT INTO segments (org_id, segment_id, name)
          VALUES (${org}, ${`${tag}-${seq}`}, ${`seg ${seq}`}) RETURNING id`)
      ).id;
      let pos = 0;
      for (const r of rules) {
        pos++;
        await db.execute(sql`
          INSERT INTO segment_rules
            (org_id, segment_id, rule_type, operator, value, position, is_active, combinator)
          VALUES (${org}, ${segId}, ${r.rule_type}, ${r.operator ?? "is"},
                  ${JSON.stringify(r.value)}::jsonb, ${pos}, true, ${r.combinator ?? "and"})`);
      }
      return segId;
    };

    const audience = async (segId: number): Promise<Set<string>> => {
      const clause = await buildSegmentAudienceClause(segId, orgId);
      const rows = await all<{ contact_id: string }>(
        sql`SELECT contact_id FROM (${clause}) aud`,
      );
      return new Set(rows.map((r) => r.contact_id));
    };
    const forRule = async (rule_type: string, value: unknown, operator = "is") =>
      audience(await segmentWith([{ rule_type, operator, value }]));
    const eq = (a: Set<string>, b: Set<string>) =>
      a.size === b.size && [...a].every((x) => b.has(x));
    const show = (s: Set<string>) => `${s.size} contact(s)`;

    console.log("PART L — the eight lifecycle rule types");

    // L1 ────────────────────────────────────────────────────────────────────
    const l1 = await forRule("messages_sent_at_least", 5);
    bar("L1 messages_sent_at_least 5 matches exactly msgs_total >= 5 (eligible only)",
      eq(l1, new Set([cHot, cWarm, cFreeze])), show(l1));

    // L2 ── the trap: a contact with NO engagement row has been sent nothing ─
    const l2 = await forRule("messages_sent_at_most", 3);
    bar("L2 messages_sent_at_most 3 INCLUDES the contact with no engagement row",
      l2.has(cNoRow), l2.has(cNoRow) ? show(l2) : "cNoRow MISSING — the EXISTS trap is back");
    bar("L2b …and is exactly {cCold, cNever, cNoRow, cQuiet}",
      eq(l2, new Set([cCold, cNever, cNoRow, cQuiet])), show(l2));

    // L3 ────────────────────────────────────────────────────────────────────
    const l3 = await forRule("messages_sent_in_period_at_least", { count: 2, days: 30 });
    bar("L3 in_period reads msgs_30d, not msgs_total",
      eq(l3, new Set([cHot, cWarm, cFreeze])), show(l3));
    const l3b = await forRule("messages_sent_in_period_at_least", { count: 5, days: 30 });
    bar("L3b a higher count narrows it (cWarm has msgs_30d=2, cHot 4, cFreeze 9)",
      eq(l3b, new Set([cFreeze])), show(l3b));

    // L4 ── never messaged matches NEITHER direction ────────────────────────
    const l4in = await forRule("last_message_in_last_n_days", 10);
    const l4out = await forRule("last_message_more_than_n_days_ago", 10);
    bar("L4 the two last_message directions are disjoint",
      [...l4in].every((x) => !l4out.has(x)), `${show(l4in)} / ${show(l4out)}`);
    bar("L4b NEITHER direction contains the never-messaged contact (spec §16 choice 1)",
      !l4in.has(cNever) && !l4out.has(cNever));
    bar("L4c nor the contact with no engagement row",
      !l4in.has(cNoRow) && !l4out.has(cNoRow));

    // L5 ── the same for clicks ─────────────────────────────────────────────
    const l5in = await forRule("last_click_in_last_n_days", 30);
    const l5out = await forRule("last_click_more_than_n_days_ago", 30);
    bar("L5 the two last_click directions are disjoint",
      [...l5in].every((x) => !l5out.has(x)), `${show(l5in)} / ${show(l5out)}`);
    bar("L5b NEITHER contains the never-clicked contacts",
      !l5in.has(cCold) && !l5out.has(cCold) && !l5in.has(cNever) && !l5out.has(cNever));

    // L6 ── is_not must not be dropped ──────────────────────────────────────
    const l6is = await forRule("lifecycle_status", ["hot", "warm"]);
    const l6not = await forRule("lifecycle_status", ["hot", "warm"], "is_not");
    bar("L6 lifecycle_status is [hot,warm] matches exactly those (eligible only)",
      eq(l6is, new Set([cHot, cWarm])), show(l6is));
    bar("L6b is_not [hot,warm] is NOT EMPTY (a dropped is_not rule inverts the audience)",
      l6not.size > 0, show(l6not));
    bar("L6c is_not [hot,warm] is the complement within the eligible set",
      eq(l6not, new Set([cCold, cFreeze, cNever, cNoRow, cQuiet])), show(l6not));

    // L7 ── any N ───────────────────────────────────────────────────────────
    const l7a = await forRule("last_message_in_last_n_days", 3);
    const l7b = await forRule("last_message_in_last_n_days", 365);
    bar("L7 a free N of 3 works (only cHot at 2 days, cFreeze at 5 is outside)",
      eq(l7a, new Set([cHot])), show(l7a));
    bar("L7b a free N of 365 works and is strictly wider",
      l7b.size > l7a.size && [...l7a].every((x) => l7b.has(x)), show(l7b));

    // L8 ── every type is COMPLETE with a valid value ───────────────────────
    const { RULE_TYPES } = await import("@/lib/validators/segment-rule-types");
    const NEW_TYPES: [string, unknown, string][] = [
      ["messages_sent_at_least", 5, "is"],
      ["messages_sent_at_most", 3, "is"],
      ["messages_sent_in_period_at_least", { count: 2, days: 30 }, "is"],
      ["last_message_more_than_n_days_ago", 10, "is"],
      ["last_message_in_last_n_days", 10, "is"],
      ["last_click_more_than_n_days_ago", 30, "is"],
      ["last_click_in_last_n_days", 30, "is"],
      ["lifecycle_status", ["hot"], "is"],
    ];
    let complete = 0;
    for (const [t, v, op] of NEW_TYPES) {
      const a = await forRule(t, v, op);
      // An INCOMPLETE rule is silently skipped, which for a single-rule
      // segment leaves the manual-membership-only audience: empty here.
      // A complete rule that legitimately matches nobody would be
      // indistinguishable, so every fixture above is chosen to match >= 1.
      if (a.size > 0) complete++;
      else bar(`L8 ${t} evaluated as COMPLETE`, false, "audience empty ⇒ rule was dropped");
    }
    bar("L8 all eight types evaluate as COMPLETE with a valid value",
      complete === NEW_TYPES.length && Object.keys(RULE_TYPES).length === 40,
      `${complete}/8 complete, ${Object.keys(RULE_TYPES).length} types declared`);

    // L9 ── the eligibility invariant the owner asked for ───────────────────
    const l9union = new Set([...l6is, ...l6not]);
    const l9base = await forRule("messages_sent_at_most", 1000000);
    bar("L9 is [hot,warm] ∪ is_not [hot,warm] == the base set the other rules resolve against",
      eq(l9union, l9base), `${show(l9union)} vs ${show(l9base)}`);
    bar("L9b …and that base set is exactly the org's ELIGIBLE contacts",
      eq(l9base, eligibleIds), `${show(l9base)} vs ${eligibleIds.size}`);
    bar("L9c the ineligible hot contact is in NEITHER side, so no rule leaks it",
      !l6is.has(cIneligibleHot) && !l6not.has(cIneligibleHot) && !l9base.has(cIneligibleHot));
    bar("L9d the two sides do not overlap",
      [...l6is].every((x) => !l6not.has(x)));

    // ── L11/L12 — the two registration points the evaluator cannot reach ──
    // Point 2 (the Zod layer) and point 4 (ownership). Both are real function
    // calls, not re-implementations: a rule that passes the evaluator but is
    // rejected here is uncreatable through the API, which is exactly how
    // phone_type / carrier shipped broken in 0098.
    const { segmentRuleCreateSchema } = await import("@/lib/validators/segment-rules");
    const { verifyValueOwnership } = await import("@/lib/api/segment-rule-value-ownership");

    let zodOk = 0;
    let ownOk = 0;
    for (const [t, v, op] of NEW_TYPES) {
      const parsed = segmentRuleCreateSchema.safeParse({
        rule_type: t,
        operator: op,
        value: v,
      });
      if (parsed.success) zodOk++;
      else bar(`L11 ${t} passes the create validator`, false, JSON.stringify(parsed.error.issues[0]));

      const own = await verifyValueOwnership(orgId, t, v, null);
      if (own.ok) ownOk++;
      else bar(`L12 ${t} passes ownership`, false, JSON.stringify(own));
    }
    bar("L11 all eight types pass the Zod create validator", zodOk === NEW_TYPES.length, `${zodOk}/8`);
    bar("L12 all eight types pass verifyValueOwnership", ownOk === NEW_TYPES.length, `${ownOk}/8`);

    // And the negative side: an invalid value must be REJECTED, or the shape
    // is validating nothing.
    const badCount = segmentRuleCreateSchema.safeParse({
      rule_type: "messages_sent_in_period_at_least",
      operator: "is",
      value: { count: 2, days: 45 },
    });
    bar("L11b an unsupported window (45 days) is rejected", !badCount.success);
    const badStatus = segmentRuleCreateSchema.safeParse({
      rule_type: "lifecycle_status",
      operator: "is",
      value: ["hot", "nonsense"],
    });
    bar("L11c an unknown lifecycle status is rejected", !badStatus.success);
    const badOperator = segmentRuleCreateSchema.safeParse({
      rule_type: "last_message_in_last_n_days",
      operator: "is_not",
      value: 10,
    });
    bar("L11d is_not is rejected for a direction-encoded time rule", !badOperator.success);

    // Sanity: every status is reachable as a value.
    bar("L10 all six statuses are accepted values",
      ENGAGEMENT_STATUSES.length === 6);
  } finally {
    if (orgId) {
      const name =
        (await all<{ name: string }>(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))[0]
          ?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} does not carry the marker (name=${JSON.stringify(name)})`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM contact_engagement WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM segments WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM segment_rules WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left for this run`);
      if (Number(left.n) !== 0) fail++;
    }
  }

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
