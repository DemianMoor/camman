import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { evaluateLeadRouting } from "@/lib/drip/routing-eval";
import { dripConfigSchema } from "@/lib/validators/drip-campaigns";

// Drip state/country include/exclude mode.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-geo-exclude-mode.ts
//
// Runs evaluateLeadRouting — the routing worker's eligibility check — against
// fixtures inside a transaction that is always rolled back. The cases:
//   exclude mode: allowed state ⇒ routed; excluded state ⇒ skipped WITH a reason
//   naming the exclusion; no state ⇒ passes (unknown ≠ excluded).
//   include mode (no mode key, today's configs): unchanged — no-state skipped as
//   `missing`, out-of-list `mismatch`, in-list pass.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

class Rollback extends Error {}

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}`);

  console.log("\nvalidator:");
  const base = { interest_tag: "ACA" };
  check("filters without a mode key validate (existing configs)",
        dripConfigSchema.safeParse({ ...base, filters: { state: ["TX"] } }).success, true);
  check("state_mode 'exclude' validates",
        dripConfigSchema.safeParse({ ...base, filters: { state: ["TX"], state_mode: "exclude" } }).success, true);
  check("country_mode 'exclude' validates",
        dripConfigSchema.safeParse({ ...base, filters: { country: ["CA"], country_mode: "exclude" } }).success, true);
  check("an unknown mode is rejected",
        dripConfigSchema.safeParse({ ...base, filters: { state: ["TX"], state_mode: "except" } }).success, false);

  try {
    await db.transaction(async (tx) => {
      const orgId = ((await tx.execute(sql`
        SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as { id: string }[])[0]?.id;
      if (!orgId) throw new Error("no organization in the preview database");
      const sfx = String(Date.now()).slice(-7);
      const tag = `GEOX${sfx}`; // unique tag ⇒ every other drip campaign mismatches on interest_tag

      const keyId = ((await tx.execute(sql`
        INSERT INTO partner_keys (org_id, partner_slug, name, token, secret_hash)
        VALUES (${orgId}, ${"geox-" + sfx}, 'geox', ${"tokgeox" + sfx}, 'h')
        RETURNING id`)) as unknown as { id: number }[])[0].id;

      const mkCampaign = async (n: string, filters: Record<string, unknown>) => {
        const id = ((await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name, status, type)
          VALUES (${orgId}, ${"geox-" + sfx + "-" + n}, ${"GEOX " + n}, 'active', 'drip')
          RETURNING id`)) as unknown as { id: number }[])[0].id;
        await tx.execute(sql`
          INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, filters)
          VALUES (${id}, ${orgId}, ${tag}, ${JSON.stringify(filters)}::jsonb)`);
        return id;
      };
      const mkLead = async (n: number, attrs: { state?: string; country?: string } | null) => {
        const contactId = ((await tx.execute(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1997" + sfx + n})
          RETURNING id`)) as unknown as { id: string }[])[0].id;
        if (attrs) {
          await tx.execute(sql`
            INSERT INTO contact_attributes (contact_id, org_id, state, country)
            VALUES (${contactId}, ${orgId}, ${attrs.state ?? null}, ${attrs.country ?? null})`);
        }
        return ((await tx.execute(sql`
          INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, interest_tag, received_at)
          VALUES (${orgId}, ${contactId}, ${keyId}, 'geox', ${tag}, now())
          RETURNING id`)) as unknown as { id: string }[])[0].id;
      };

      const leadCA = await mkLead(1, { state: "CA", country: "US" });
      const leadTX = await mkLead(2, { state: "TX", country: "US" });
      const leadNone = await mkLead(3, null);
      const leadLowerFl = await mkLead(4, { state: "fl" });

      const verdictFor = async (leadId: string, campaignId: number) => {
        const v = await evaluateLeadRouting(tx, { orgId, leadEventId: leadId });
        const c = v!.candidates.find((x) => x.campaign_id === campaignId)!;
        return { v: v!, c };
      };

      // ── exclude mode, alone (so the winner is unambiguous) ─────────────────
      console.log("\nexclude mode — state [TX, FL], 'All except these':");
      const ex = await mkCampaign("exclude", { state: ["TX", "FL"], state_mode: "exclude" });

      let r = await verdictFor(leadCA, ex);
      check("lead from an allowed state (CA): filter_state pass", r.c.rules.filter_state, "pass");
      check("lead from an allowed state (CA): ⭐ ROUTED (winner = exclude campaign)",
            r.v.winner?.campaign_id, ex);

      r = await verdictFor(leadTX, ex);
      check("lead from an excluded state (TX): filter_state mismatch", r.c.rules.filter_state, "mismatch");
      check("lead from an excluded state (TX): ⭐ SKIPPED (no winner)", r.v.winner, null);
      const reason = r.c.detail.filter_state ?? "";
      console.log(`        reason: ${reason}`);
      check("excluded lead's reason names the exclusion",
            reason.includes("excluded list") && reason.includes("exclude mode"), true);
      check("excluded lead's reason states the unknown-passes rule",
            reason.includes("no state would have passed"), true);

      r = await verdictFor(leadNone, ex);
      check("lead with NO state data: ⭐ filter_state pass (unknown ≠ excluded)", r.c.rules.filter_state, "pass");
      check("lead with NO state data: ⭐ ROUTED", r.v.winner?.campaign_id, ex);

      r = await verdictFor(leadLowerFl, ex);
      check("lowercase 'fl' against an 'FL' exclusion is still excluded", r.c.rules.filter_state, "mismatch");

      // ── include mode: a config with NO mode key, exactly like today's ──────
      console.log("\ninclude mode (no mode key — e.g. campaign 1006's {state:[TX,FL]}):");
      await tx.execute(sql`UPDATE campaigns SET status = 'paused' WHERE id = ${ex}`);
      const inc = await mkCampaign("include", { state: ["TX", "FL"] });

      r = await verdictFor(leadTX, inc);
      check("in-list lead (TX): pass + routed", [r.c.rules.filter_state, r.v.winner?.campaign_id], ["pass", inc]);
      r = await verdictFor(leadCA, inc);
      check("out-of-list lead (CA): mismatch, not routed", [r.c.rules.filter_state, r.v.winner], ["mismatch", null]);
      r = await verdictFor(leadNone, inc);
      check("no-state lead: ⭐ still 'missing' (skip-if-missing unchanged)",
            [r.c.rules.filter_state, r.v.winner], ["missing", null]);

      // A garbage mode value must read as include (positive read).
      await tx.execute(sql`
        UPDATE drip_campaign_configs SET filters = '{"state":["TX","FL"],"state_mode":"bogus"}'::jsonb
        WHERE campaign_id = ${inc}`);
      r = await verdictFor(leadNone, inc);
      check("unknown stored mode reads as include (no-state ⇒ missing)", r.c.rules.filter_state, "missing");

      // ── country: same semantics ────────────────────────────────────────────
      console.log("\ncountry — 'All except these' [US]:");
      await tx.execute(sql`UPDATE campaigns SET status = 'paused' WHERE id = ${inc}`);
      const cex = await mkCampaign("country-exclude", { country: ["US"], country_mode: "exclude" });
      r = await verdictFor(leadCA, cex); // country US
      check("US lead excluded", [r.c.rules.filter_country, r.v.winner], ["mismatch", null]);
      r = await verdictFor(leadNone, cex);
      check("no-country lead passes + routed", [r.c.rules.filter_country, r.v.winner?.campaign_id], ["pass", cex]);
      r = await verdictFor(leadLowerFl, cex); // has state, no country
      check("lead with state but no country passes", r.c.rules.filter_country, "pass");

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    console.log("\n(fixtures rolled back)");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  await pgConn.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end();
  process.exit(1);
});
