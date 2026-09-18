import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

// ── the lane REGISTRY ────────────────────────────────────────────────────────
//
// Moved here from scripts/test-behavioral-split.ts, which needs a database for
// everything else it does: this bar needs none, and lib/stages/split-group.ts
// states the team's rule for exactly this class of guard — "it lives in the pure
// suite, not next to the map, so it runs with no DB".
//
// READ FROM SOURCE, not imported: lib/stages/behavioral-split.ts pulls in the db
// client at module scope, which would end this file's purity. Reading the
// literal keeps the two facts independent — the registry the split offers, and
// the scale's own lane set — which is the whole point. Those two having drifted
// is how tier 3 reached the confirm dialog as a blank tickable row that 400'd
// the entire split when ticked.
const srcOf = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
/** Line-scoped `--` (SQL) and `//` (TS) comment strip, then whitespace collapse. */
const flatten = (s: string) =>
  s.replace(/^[ \t]*\/\/[^\n]*$/gm, "").replace(/--[^\n]*/g, "").replace(/\s+/g, " ");

const laneTiersSrc = /export const LANE_TIERS = \[([\s\S]*?)\] as const;/
  .exec(srcOf("lib/stages/behavioral-split.ts"))?.[1] ?? "";
const registryTiers = [...laneTiersSrc.matchAll(/tier:\s*(\d+)/g)].map((m) => Number(m[1]));
check("P17 LANE_TIERS is readable from lib/stages/behavioral-split.ts",
  registryTiers.length > 0, laneTiersSrc);
check(`P18 ⭐ the split's LANE_TIERS registry is EXACTLY the scale's lane set (${LANE_TIER_VALUES.join(",")})`,
  JSON.stringify(registryTiers) === JSON.stringify([...LANE_TIER_VALUES]),
  `LANE_TIERS=[${registryTiers.join(",")}]`);
check(`P19 ⭐ ...and it never offers the exit tier ${EXIT_TIER} as a lane`,
  registryTiers.length > 0 && !registryTiers.includes(EXIT_TIER),
  `LANE_TIERS=[${registryTiers.join(",")}]`);

// ── ⭐ THE TWO INLINE COPIES IN lib/drip/lifecycle.ts ────────────────────────
//
// `closeCompletedJourneys` and `expireJourneysPastEndDate` each carry an INLINE
// copy of this file's tier scale, because their predicate is correlated per
// journey row (j.campaign_id / j.contact_id) while campaignTierExpr takes a
// literal campaign id. That cannot be refactored away — so the copies must be
// GUARDED instead, and until now they were not: docs/07-conventions.md
// prescribed a grep a human has to remember to run, which is the weakest form of
// the guard that same document argues for.
//
// A DIVERGENCE HERE IS WHAT CAUSED PHASE 4's BUG. The copies topped out at tier
// 2 while this file went to 4, so a registrant read 3 in campaign-tier.ts (no
// 0/1/2 lane can match them, nothing is sent) and ≤2 in the lifecycle (the
// tier-2 child is still judged owed) — and their journey hung for ever, holding
// that contact's only live-journey slot against every future journey too.
//
// WHAT IS COMPARED is the part that MUST be identical: the registration test and
// the purchase-eviction NOT EXISTS (tier 3), and the purchase test (tier 4). The
// scoping deliberately differs — literal ids here, correlated columns there —
// and that difference is the reason the copy exists, so it is excluded by
// construction: the comparison starts at `AND ${registeredClause()}` and at
// `AND ${purchasedClause(…)}`, after the scope predicates end.
const tierSrc = flatten(srcOf("lib/campaign-tier.ts"));
const lifeSrc = flatten(srcOf("lib/drip/lifecycle.ts"));

/** The `(...)` starting at `from`, up to its balanced close. */
function balanced(s: string, from: number): string {
  const open = s.indexOf("(", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return s.slice(open, i + 1);
    }
  }
  return "";
}
const REG_MARK = "AND ${registeredClause()}";
/** `AND ${registeredClause()} AND NOT EXISTS ( … )` — the whole tier-3 rule. */
function registrationRule(s: string, from = 0): { rule: string; end: number } {
  const i = s.indexOf(REG_MARK, from);
  if (i < 0) return { rule: "", end: -1 };
  const ne = s.indexOf("AND NOT EXISTS", i);
  if (ne < 0) return { rule: "", end: -1 };
  const body = balanced(s, ne);
  return { rule: `${REG_MARK} AND NOT EXISTS ${body}`, end: ne + body.length };
}

const canon = registrationRule(tierSrc).rule;
check("P20 the tier-3 rule is extractable from lib/campaign-tier.ts",
  canon.includes("${registeredClause()}") &&
    canon.includes("${PURCHASE_EVENT_TYPE_IDS}") &&
    canon.endsWith(")"),
  canon);

const copies: string[] = [];
for (let at = 0; ; ) {
  const found = registrationRule(lifeSrc, at);
  if (found.end < 0) break;
  copies.push(found.rule);
  at = found.end;
}
// TWO, exactly. A third inline copy added later would be unguarded by
// construction — this is the bar that notices it exists.
check("P21 ⭐ lib/drip/lifecycle.ts carries EXACTLY the two known inline copies",
  copies.length === 2, `found ${copies.length}`);
copies.forEach((c, i) => {
  check(`P22.${i + 1} ⭐ inline copy ${i + 1}'s tier-3 rule is byte-identical to lib/campaign-tier.ts's — registration test AND the purchase-eviction NOT EXISTS, status filter included`,
    c === canon && canon !== "",
    `copy: ${c}\n        canon: ${canon}`);
});

// The tier NUMBERS each copy emits. The scoping differs, the numbers must not:
// a renumber that lands in one file and not the other is precisely the Phase 4
// failure, and `SELECT 3`/`SELECT 4` are bare literals no type checker sees.
// Read from the same UNION arms, identified by their PREDICATE (not by alias),
// then compared against this file's exported constants.
const reachBlocks: string[] = [];
for (let at = 0; ; ) {
  const i = lifeSrc.indexOf("SELECT MAX(t.tier) FROM", at);
  if (i < 0) break;
  const body = balanced(lifeSrc, i + "SELECT MAX(t.tier) FROM".length);
  if (!body) break;
  reachBlocks.push(body);
  at = i + body.length;
}
check("P23 both reachability blocks are readable", reachBlocks.length === 2, `found ${reachBlocks.length}`);
reachBlocks.forEach((block, i) => {
  const arms = block.split(" UNION ALL ");
  const tierOf = (arm: string | undefined) => Number(/^\(?\s*SELECT (\d+)\b/.exec(arm ?? "")?.[1]);
  const regArm = arms.find((a) => a.includes("${registeredClause()}"));
  const buyArm = arms.find((a) => a.includes("${purchasedClause("));
  check(`P24.${i + 1} ⭐ inline copy ${i + 1}'s registration arm emits TIER_REGISTERED (${TIER_REGISTERED})`,
    tierOf(regArm) === TIER_REGISTERED, `arm: ${regArm}`);
  check(`P25.${i + 1} ⭐ inline copy ${i + 1}'s purchase arm emits TIER_PURCHASED (${TIER_PURCHASED}) and uses the SHARED purchasedClause(), not a re-typed predicate`,
    tierOf(buyArm) === TIER_PURCHASED && /\$\{purchasedClause\(("[a-z0-9_]+")?\)\}/.test(buyArm ?? ""),
    `arm: ${buyArm}`);
  // Multi-tenancy: both ledger arms carry org_id alongside the id, exactly as
  // the branches in this file do (P11).
  check(`P26.${i + 1} both ledger arms in copy ${i + 1} are org-scoped`,
    /\.org_id = j\.org_id/.test(regArm ?? "") && /\.org_id = j\.org_id/.test(buyArm ?? ""),
    `reg: ${regArm}\n        buy: ${buyArm}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
