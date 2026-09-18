import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import {
  EXIT_TIER,
  LANE_TIER_VALUES,
  TIER_CLICKED,
  TIER_IGNORED,
  TIER_PURCHASED,
  TIER_REACHED_OFFER,
  TIER_REGISTERED,
  campaignTierExpr,
} from "../lib/campaign-tier";
import { stageRecipientsSql } from "../lib/sends/recipients";
import { unlabelledLaneTiers } from "../lib/stages/split-group";

// PURE. No DB, no network. Asserts the tier SCALE and the RENDERED SQL of the two
// fragments that decide lane membership, so a renumber can never half-land:
// the fragment saying "purchase = 4" while a consumer still excludes 3 would put
// a registrant in no lane and a buyer in the Reached-offer lane.
//   npx tsx scripts/test-campaign-tier-scale.ts

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

const dialect = new PgDialect();
const render = (q: ReturnType<typeof sql>) => dialect.sqlToQuery(q).sql;

// ⚠️ THE RENDERED SQL CARRIES ITS COMMENTS, and those comments contain the words
// "rejected", "is_purchase" and "Registered". A bar that greps the raw string can
// therefore be satisfied by PROSE. Everything that asserts a PREDICATE greps this
// stripped copy instead. (Line-scoped strip: no string literal in these fragments
// contains `--`.)
const stripSqlComments = (s: string) => s.replace(/--[^\n]*/g, "");

const ORG = "00000000-0000-4000-8000-000000000001";

// ── the scale ────────────────────────────────────────────────────────────────
check("P1 the scale is 0/1/2/3/4 in behavioural rank order",
  [TIER_IGNORED, TIER_CLICKED, TIER_REACHED_OFFER, TIER_REGISTERED, TIER_PURCHASED].join(",") === "0,1,2,3,4");
check("P2 ⭐ Registered ranks ABOVE Reached offer and BELOW Purchased",
  TIER_REACHED_OFFER < TIER_REGISTERED && TIER_REGISTERED < TIER_PURCHASED);
check("P3 the exit is the TOP of the scale, so MAX() picks it",
  EXIT_TIER === TIER_PURCHASED && EXIT_TIER === Math.max(TIER_IGNORED, TIER_CLICKED, TIER_REACHED_OFFER, TIER_REGISTERED, TIER_PURCHASED));
check("P4 the lane values are every tier EXCEPT the exit",
  LANE_TIER_VALUES.join(",") === "0,1,2,3" && !LANE_TIER_VALUES.includes(EXIT_TIER));

// ── the fragment ─────────────────────────────────────────────────────────────
const frag = render(campaignTierExpr(1234, ORG));
check("P5 the click branch still emits 1", /\b1 AS tier\b/.test(frag), frag);
check("P6 the offer-reach branch still emits 2", /\b2 AS tier\b/.test(frag), frag);
check("P7 ⭐ a registration branch emits 3", /\b3 AS tier\b/.test(frag), frag);
check("P8 ⭐ the purchase branch emits 4, not 3", /\b4 AS tier\b/.test(frag), frag);
check("P9 the tiers are literals, not bind parameters (a UNION ALL cannot type $n)",
  !/\$\d+ AS tier/.test(frag), frag);
// ⚠️ P10 USED TO ASSERT `/NOT EXISTS/ && /et.is_purchase/` — which the TIER-4
// BRANCH ALONE satisfies (it carries `et.is_purchase`, and a `NOT EXISTS` lives
// elsewhere in the fragment), so it degenerated to "a NOT EXISTS exists
// somewhere" and could not go red on the mutation it was written for. The
// exclusion subquery is the only place the fragment aliases the ledger as `pe`,
// so every predicate below is grepped `pe.`-qualified, against the
// comment-stripped SQL.
const bare = stripSqlComments(frag);
check("P10 ⭐ the registration branch carries a CORRELATED NOT EXISTS over PURCHASE-TYPE ledger rows (contact + campaign + org), not merely some NOT EXISTS somewhere",
  /NOT EXISTS\s*\(\s*SELECT 1\s+FROM conversion_events pe\b/.test(bare)
    && /pe\.event_type_id IN \(SELECT et\.id FROM event_types et WHERE et\.is_purchase\)/.test(bare)
    && /pe\.contact_id = ce\.contact_id/.test(bare)
    && /pe\.campaign_id = ce\.campaign_id/.test(bare)
    && /pe\.org_id = ce\.org_id/.test(bare), bare);
// The status half, separated so its red names the rule it breaks. `IS NOT NULL`
// = ANY KNOWN status, which is what makes a REJECTED purchase evict a registrant
// (the user's binding decision). Narrowing it to `IN ('pending','approved')` —
// the one-character-class mutation that passes every other bar in this file and
// leaves T6 green — reds exactly here and at T3 in
// scripts/test-registered-lane-db.ts.
check("P10b ⭐ ...and its status predicate is ANY KNOWN status (IS NOT NULL), so a REJECTED purchase DOES evict a registrant — never a counted-status list, which would let a rejected buyer back into the Registered lane",
  /AND pe\.status IS NOT NULL/.test(bare) && !/pe\.status IN \(/.test(bare), bare);
check("P11 both ledger branches carry org_id as well as campaign_id",
  (frag.match(/ce\.org_id =/g) ?? []).length >= 2, frag);
check("P12 the output shape is unchanged: (contact_id, tier) with MAX high-water",
  /SELECT contact_id, MAX\(tier\)::int AS tier/.test(frag), frag);

// ── the lane guard ───────────────────────────────────────────────────────────
const laneSql = render(
  stageRecipientsSql({
    campaignId: 1234,
    orgId: ORG,
    filters: {
      includeNoStatus: true,
      includeClickers: true,
      excludeClickers: false,
      splitIndex: null,
      splitTotal: null,
      behavioralTier: 3,
      parentStageId: 99,
    },
  }),
);
check("P13 ⭐ the lane exit guard excludes 4", /coalesce\(bt\.tier, 0\) <> 4/.test(laneSql), laneSql);
check("P14 ⭐ the lane exit guard no longer excludes 3 (that IS a lane now)",
  !/coalesce\(bt\.tier, 0\) <> 3/.test(laneSql), laneSql);

const plainSql = render(
  stageRecipientsSql({
    campaignId: 1234,
    orgId: ORG,
    filters: {
      includeNoStatus: true,
      includeClickers: true,
      excludeClickers: false,
      splitIndex: null,
      splitTotal: null,
    },
  }),
);
check("P15 an ORDINARY stage still emits no tier join and no exit guard",
  !/bt\.tier/.test(plainSql) && !/campaign_tier/.test(plainSql), plainSql);

// ── the lane labels ──────────────────────────────────────────────────────────
// A tier with no label is not a type error and not a crash: it is a BLANK,
// TICKABLE row with a live count in the split confirm dialog (which renders
// `{ln.label}` raw), and ticking it 400s the WHOLE split. Tier 3 shipped exactly
// that way. This bar is here — not next to the map — so the NEXT tier inserted
// into LANE_TIER_VALUES cannot repeat it silently: add the value, this goes red.
check("P16 ⭐ every LANE_TIER_VALUES tier has a label in split-group's TIER_LABEL (a missing key renders a BLANK tickable row in the split dialog)",
  unlabelledLaneTiers().length === 0,
  `unlabelled tiers: ${unlabelledLaneTiers().join(",") || "(none)"}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
