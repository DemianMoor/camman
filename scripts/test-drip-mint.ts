import "./_env-preload";
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { mintDripLeadLink } from "@/lib/drip/mint";
import { mintLink } from "@/lib/links/mint-link";

// Drip per-lead link minting (Drip Phase 5, ruling D).
//
// ⭐ WHAT WENT WRONG. The scheduler rendered with `linkUrl: stage.short_url` — a
// STATIC column, NULL on every drip stage — so the message shipped as copy
// ending in a colon and nothing after it, with stage_sends.link_id NULL: no /r/
// redirect, no click, no Keitaro attribution. It answered every internal check,
// because nothing asserted that a drip send carries a link.
//
// ⭐ SO THE CENTRAL ASSERTION IS THE DESTINATION, NOT "a link exists".
// A mint that produced a link to the WRONG place would satisfy "link_id is not
// null" perfectly. This resolves the minted code all the way through
// link_destinations and compares the URL byte-for-byte with the one the landing
// page + brand host + stage tracking id must produce.
//
// Everything runs in a rolled-back probe transaction.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  console.log(`target ref: ${/postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1]}`);
  let rolledBack = false;

  try {
    await db.transaction(async (tx) => {
      const orgId = (
        (await tx.execute(sql`
          SELECT id FROM organizations ORDER BY created_at LIMIT 1
        `)) as unknown as { id: string }[]
      )[0].id;
      const sfx = String(Date.now()).slice(-7);

      // A brand with a landing host and its own active short domain.
      const brandId = (
        (await tx.execute(sql`
          INSERT INTO brands (org_id, brand_id, name, status, landing_host)
          VALUES (${orgId}, ${"mp" + sfx}, ${"mint probe " + sfx}, 'active', 'www.lumzen.co')
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      await tx.execute(sql`
        INSERT INTO short_domains (org_id, brand_id, domain, status, is_default)
        VALUES (${orgId}, ${brandId}, ${"s" + sfx + ".example.com"}, 'active', true)`);

      // An existing offer — the probe only needs something to hang a landing
      // page off, and synthesizing one means satisfying unrelated NOT NULLs.
      const offerId = (
        (await tx.execute(sql`
          SELECT id FROM offers WHERE archived_at IS NULL ORDER BY id LIMIT 1
        `)) as unknown as { id: number }[]
      )[0].id;
      const goodPage = (
        (await tx.execute(sql`
          INSERT INTO offer_landing_pages (org_id, offer_id, title, kind, slug, status)
          VALUES (${orgId}, ${offerId}, ${"probe " + sfx}, 'slug', ${"pb" + sfx.slice(-4)}, 'active')
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;

      const campId = (
        (await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name, status, type, link_mode, brand_id, offer_id, tracking_id)
          VALUES (${orgId}, ${"mint-" + sfx}, 'mint probe', 'active', 'drip', 'tracked',
                  ${brandId}, ${offerId}, ${"9_9_010125_" + sfx})
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const stageId = (
        (await tx.execute(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, window_start_min, window_end_min,
             drip_active, landing_page_id, tracking_id)
          VALUES (${orgId}, ${campId}, 1, 0, 1440, true, ${goodPage}, ${"9_9_010125_" + sfx + "_s1_c1"})
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const contactId = (
        (await tx.execute(sql`
          INSERT INTO contacts (org_id, phone_number)
          VALUES (${orgId}, ${"+1999" + sfx}) RETURNING id`)) as unknown as { id: string }[]
      )[0].id;

      const phoneId = (
        (await tx.execute(sql`
          SELECT id FROM provider_phones WHERE archived_at IS NULL ORDER BY id LIMIT 1
        `)) as unknown as { id: number }[]
      )[0].id;

      const baseInput = {
        orgId,
        campaignId: campId,
        stageId,
        contactId,
        creativeId: null,
        brandId,
        providerPhoneId: phoneId,
        campaignTrackingId: `9_9_010125_${sfx}`,
        stageTrackingId: `9_9_010125_${sfx}_s1_c1`,
        brandLandingHost: "www.lumzen.co",
      };
      const goodPageRef = {
        id: goodPage,
        kind: "slug",
        slug: `pb${sfx.slice(-4)}`,
        external_url: null,
        status: "active",
      };

      // ── 1. the happy path ────────────────────────────────────────────────
      console.log("\n1. mint round-trip:");
      const r = await mintDripLeadLink(tx, {
        ...baseInput,
        sendToken: randomUUID(),
        landingPage: goodPageRef,
      });
      check("mint succeeded", r.ok, true);
      if (!r.ok) throw new Error("ROLLBACK");
      check("a link id came back", Number.isInteger(r.linkId), true);
      check("the /r/ URL uses the brand's short domain",
            r.linkUrl.startsWith(`https://s${sfx}.example.com/r/`), true);

      // ⭐ resolve the code back to its destination — the assertion that matters.
      const resolved = (await tx.execute(sql`
        SELECT l.code, l.campaign_tracking_id, l.stage_tracking_id, l.contact_id,
               d.url AS destination
        FROM links l JOIN link_destinations d ON d.id = l.destination_id
        WHERE l.id = ${r.linkId}`)) as unknown as Record<string, unknown>[];
      const expectedUrl = `https://www.lumzen.co/lp/pb${sfx.slice(-4)}?sub_id3=${encodeURIComponent(`9_9_010125_${sfx}_s1_c1`)}`;
      check("⭐ the code resolves to the constructed landing-page URL",
            resolved[0]?.destination, expectedUrl);
      check("...and the /r/ URL carries that same code",
            r.linkUrl.endsWith(`/r/${resolved[0]?.code}`), true);
      check("the link carries the campaign tracking id",
            resolved[0]?.campaign_tracking_id, `9_9_010125_${sfx}`);
      check("the link carries the stage tracking id",
            resolved[0]?.stage_tracking_id, `9_9_010125_${sfx}_s1_c1`);
      check("the link is bound to THIS contact", resolved[0]?.contact_id, contactId);

      // ── 2. fail closed ───────────────────────────────────────────────────
      // ⚠️ Each case also asserts NO link row appeared. A refusal that still
      // minted would leave the message linkless AND the ledger dirty.
      console.log("\n2. ⭐ fail closed — every refusal, and no link left behind:");
      const before = (
        (await tx.execute(sql`
          SELECT count(*)::int AS n FROM links WHERE stage_id = ${stageId}
        `)) as unknown as { n: number }[]
      )[0].n;

      const cases: [string, Record<string, unknown>, string][] = [
        ["no landing page at all",
         { landingPage: { id: null, kind: null, slug: null, external_url: null, status: null } },
         "no_landing_page"],
        ["a DISABLED landing page",
         { landingPage: { ...goodPageRef, status: "disabled" } },
         "invalid_destination"],
        ["a malformed slug",
         { landingPage: { ...goodPageRef, slug: "not a slug!" } },
         "invalid_destination"],
        ["the brand has no landing host",
         { brandLandingHost: null },
         "brand_missing_landing_host"],
        ["the stage has no tracking id",
         { stageTrackingId: null },
         "missing_tracking_id"],
        ["the campaign has no tracking id",
         { campaignTrackingId: null },
         "missing_tracking_id"],
      ];
      for (const [label, override, reason] of cases) {
        const res = await mintDripLeadLink(tx, {
          ...baseInput,
          sendToken: randomUUID(),
          landingPage: goodPageRef,
          ...override,
        } as Parameters<typeof mintDripLeadLink>[1]);
        check(`${label} ⇒ refused (${reason})`, res.ok === false && res.reason, reason);
      }
      const after = (
        (await tx.execute(sql`
          SELECT count(*)::int AS n FROM links WHERE stage_id = ${stageId}
        `)) as unknown as { n: number }[]
      )[0].n;
      check("⭐ not one refusal minted a link", after, before);

      // ── 3. the REGULAR path is untouched ─────────────────────────────────
      // mintLink is what kickoff calls. Drip wraps it; it must still behave
      // exactly as before for a caller that supplies its own destination.
      console.log("\n3. the regular path's mintLink is unchanged:");
      const sdId = (
        (await tx.execute(sql`
          SELECT id FROM short_domains WHERE brand_id = ${brandId} LIMIT 1
        `)) as unknown as { id: number }[]
      )[0].id;
      const token = randomUUID();
      const direct = await mintLink(tx, {
        orgId,
        campaignId: campId,
        stageId,
        contactId,
        creativeId: null,
        shortDomainId: sdId,
        destinationUrl: "https://example.com/regular?x=1",
        sendToken: token,
        campaignTrackingId: `9_9_010125_${sfx}`,
        stageTrackingId: `9_9_010125_${sfx}_s1_c1`,
      });
      check("a direct mint still works", Number.isInteger(direct.id), true);
      check("...and is not marked reused", direct.reused, false);
      const same = await mintLink(tx, {
        orgId,
        campaignId: campId,
        stageId,
        contactId,
        creativeId: null,
        shortDomainId: sdId,
        destinationUrl: "https://example.com/regular?x=1",
        sendToken: token,
        campaignTrackingId: `9_9_010125_${sfx}`,
        stageTrackingId: `9_9_010125_${sfx}_s1_c1`,
      });
      check("⭐ same send token ⇒ the SAME link, not a second one", same.id, direct.id);
      check("...and it reports itself reused", same.reused, true);
      const dest = (await tx.execute(sql`
        SELECT d.url FROM links l JOIN link_destinations d ON d.id = l.destination_id
        WHERE l.id = ${direct.id}`)) as unknown as { url: string }[];
      check("the direct mint kept its caller-supplied destination",
            dest[0]?.url, "https://example.com/regular?x=1");

      rolledBack = true;
      throw new Error("ROLLBACK");
    });
  } catch (e) {
    if ((e as Error).message !== "ROLLBACK") throw e;
  }
  check("probe rolled back", rolledBack, true);
  const left = (await db.execute(sql`
    SELECT count(*)::int AS n FROM campaigns WHERE name = 'mint probe'
  `)) as unknown as { n: number }[];
  check("nothing left behind", left[0]?.n, 0);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  await pgConn.end();
  if (failures > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error("ERR", e);
  await pgConn.end();
  process.exit(1);
});
