import "./_env-preload";

import { dripInUseSubquery, inUseSetBody } from "@/lib/drip/in-use";
import { sql as pgConn } from "@/db/client";

// R14 / G2 shape guard (Drip Phase 4).
//
// ⭐ WHAT THIS ACTUALLY PROTECTS. R14 says regular-campaign activation must be
// UNCHANGED by drip — not "close", unchanged. The way that is achieved is that
// with drip posture OFF the in-use builder emits character-for-character the SQL
// it emitted before Phase 4, so the planner cannot produce a different plan.
//
// That guarantee is invisible: nothing about `inUseSetBody` makes it obvious
// that the posture-off branch is load-bearing, and a well-meaning reformat —
// renaming an alias, re-indenting, "tidying" the join — would silently change
// every regular campaign's activation plan with no test failing. So the
// pre-Phase-4 text is FROZEN here as a literal and compared.
//
// ⭐ AND IT ASSERTS BOTH DIRECTIONS. A test that only pinned the off-shape would
// pass if the drip branch were never emitted at all, which would silently break
// G2 instead. So: off ⇒ exactly the frozen text; on ⇒ the union present and the
// journey states named.
//
// Pure string comparison. No database is read (the connection is opened by the
// shared client module and closed at the end).

const ORG = "00000000-0000-4000-8000-000000000001";

// ⚠️ FROZEN. Copied from lib/audience-snapshot.ts as it stood at f3dc548,
// immediately before Phase 4. Do not "fix" this to match new output — if it
// no longer matches, the OUTPUT changed, and that is the thing to look at.
const FROZEN_PRE_P4 = `
      select distinct p.contact_id
      from campaign_audience_pool p
      join campaigns ca on ca.id = p.campaign_id
      where p.org_id = $?::uuid and ca.status = 'active'`;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) {
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
  }
}

/**
 * Render a Drizzle SQL chunk to its parameterised text, like the driver would.
 *
 * ⚠️ Must RECURSE. `inUseSetBody` composes by embedding SQL objects inside a
 * template (`sql`${regular} union ${drip}``), and those nested objects appear in
 * queryChunks as SQL instances, not as parameters. A flat renderer treats each
 * one as a bind placeholder and reports the union branch as missing — which is
 * a failure of the test, not of the code under test.
 */
function render(chunk: unknown): string {
  const c = chunk as { queryChunks?: unknown[]; value?: unknown[] };
  if (c && Array.isArray(c.queryChunks)) {
    return c.queryChunks.map(render).join("");
  }
  if (c && Array.isArray(c.value)) return c.value.join("");
  return "$?";
}

function main() {
  console.log("posture OFF — must be byte-identical to pre-Phase-4:");
  const off = render(inUseSetBody(ORG, false));
  check("⭐ emitted SQL equals the frozen pre-Phase-4 text", off, FROZEN_PRE_P4);
  check("no union appears", /union/i.test(off), false);
  check("drip_journeys is not mentioned at all", /drip_journeys/.test(off), false);
  check("dripInUseSubquery returns null (caller cannot splice an empty branch)",
        dripInUseSubquery(ORG, false), null);

  console.log("\nposture ON — the drip branch must actually be there:");
  const on = render(inUseSetBody(ORG, true));
  check("⭐ a union is emitted", /union/i.test(on), true);
  check("drip_journeys is joined in", /drip_journeys/.test(on), true);
  check("only LIVE journey states count", /'routed', 'active'/.test(on), true);
  check("completed journeys are NOT counted as in use", /'completed'/.test(on), false);
  check("the original branch is still present verbatim",
        on.startsWith(FROZEN_PRE_P4), true);

  console.log("\nthe two in-use sites share one builder:");
  const sub = dripInUseSubquery(ORG, true);
  check("dripInUseSubquery returns SQL when posture is on", sub !== null, true);
  const subText = render(sub);
  check("...and it is the same fragment the union uses", on.includes(subText.trim()), true);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
void pgConn.end({ timeout: 5 }).catch(() => {});
