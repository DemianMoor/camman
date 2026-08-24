import "./_env-preload";
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { mintDripLeadLink } from "@/lib/drip/mint";

// Does mint honour a hand-edited Full URL, and does an UNEDITED one follow a
// re-brand? Rolled-back probe against real schema.
//
// ⭐ THE REBRAND CASE IS THE WHOLE REASON THE UNEDITED PATH CONSTRUCTS LATE.
// On 2026-08-22 two campaigns were re-branded and every stage kept pointing at
// the old brand's pages, because the destination was a frozen absolute URL.
// Building it at mint makes a re-brand self-correcting — so this asserts the
// destination changes when the campaign's brand changes, with NO edit to the
// stage at all.
//
// ⭐ AND THE EDITED CASE MUST NOT FOLLOW. That is the trade-off stated in the
// form's helper text: an operator who appends &utm_source=... is choosing a
// frozen URL. If a re-brand silently rewrote it, their params would vanish.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  console.log(`ref: ${/postgres\.([a-z0-9]+):/.exec(process.env.DATABASE_URL ?? "")?.[1]}`);
  let rolledBack = false;

  try {
    await db.transaction(async (tx) => {
      const orgId = (
        (await tx.execute(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)) as unknown as { id: string }[]
      )[0].id;
      const sfx = String(Date.now()).slice(-7);

      // Two brands, each with its own landing host and short domain.
      async function mkBrand(host: string, tag: string) {
        const id = (
          (await tx.execute(sql`
            INSERT INTO brands (org_id, brand_id, name, status, landing_host)
            VALUES (${orgId}, ${tag + sfx}, ${"probe " + tag + sfx}, 'active', ${host})
            RETURNING id`)) as unknown as { id: number }[]
        )[0].id;
        await tx.execute(sql`
          INSERT INTO short_domains (org_id, brand_id, domain, status, is_default)
          VALUES (${orgId}, ${id}, ${tag + sfx + ".example.com"}, 'active', true)`);
        return id;
      }
      // ⚠️ Real brand hosts: the 0170 CHECK's host list is literal, so a made-up
      // host would be refused by link_destinations and the probe would prove
      // nothing about the rebrand.
      const brandA = await mkBrand("www.lumzen.co", "ba");
      const brandB = await mkBrand("www.fitsyou.net", "bb");

      const offerId = (
        (await tx.execute(sql`SELECT id FROM offers WHERE archived_at IS NULL ORDER BY id LIMIT 1`)) as unknown as { id: number }[]
      )[0].id;
      const lpId = (
        (await tx.execute(sql`
          INSERT INTO offer_landing_pages (org_id, offer_id, title, kind, slug, status)
          VALUES (${orgId}, ${offerId}, ${"probe " + sfx}, 'slug', ${"pb" + sfx.slice(-4)}, 'active')
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const campId = (
        (await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name, status, type, link_mode, brand_id, offer_id, tracking_id)
          VALUES (${orgId}, ${"mh-" + sfx}, 'mint honour probe', 'active', 'drip', 'tracked',
                  ${brandA}, ${offerId}, ${"9_9_010125_" + sfx})
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const stageId = (
        (await tx.execute(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, window_start_min,
                                       window_end_min, drip_active, landing_page_id, tracking_id)
          VALUES (${orgId}, ${campId}, 1, 0, 1440, true, ${lpId}, ${"9_9_010125_" + sfx + "_s1_c1"})
          RETURNING id`)) as unknown as { id: number }[]
      )[0].id;
      const contactId = (
        (await tx.execute(sql`
          INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${"+1997" + sfx})
          RETURNING id`)) as unknown as { id: string }[]
      )[0].id;
      const phoneId = (
        (await tx.execute(sql`SELECT id FROM provider_phones WHERE archived_at IS NULL ORDER BY id LIMIT 1`)) as unknown as { id: number }[]
      )[0].id;

      const tid = `9_9_010125_${sfx}_s1_c1`;
      const slug = `pb${sfx.slice(-4)}`;
      const base = {
        orgId, campaignId: campId, stageId, contactId, creativeId: null,
        providerPhoneId: phoneId,
        campaignTrackingId: `9_9_010125_${sfx}`, stageTrackingId: tid,
        landingPage: { id: lpId, kind: "slug", slug, external_url: null, status: "active" },
      };
      const dest = async (linkId: number) =>
        (
          (await tx.execute(sql`
            SELECT d.url FROM links l JOIN link_destinations d ON d.id = l.destination_id
            WHERE l.id = ${linkId}`)) as unknown as { url: string }[]
        )[0].url;

      // ── 1. UNEDITED ⇒ constructed at mint, against brand A ────────────────
      console.log("\n1. unedited (full_url NULL) ⇒ constructed at mint:");
      const a = await mintDripLeadLink(tx, {
        ...base, brandId: brandA, brandLandingHost: "www.lumzen.co",
        handEditedUrl: null, sendToken: randomUUID(),
      });
      check("minted", a.ok, true);
      if (a.ok) {
        check("destination is brand A's host",
              await dest(a.linkId), `https://www.lumzen.co/lp/${slug}?sub_id3=${tid}`);
      }

      // ── 2. ⭐ REBRAND: same stage, campaign now on brand B ────────────────
      console.log("\n2. ⭐ re-brand the campaign — NOTHING on the stage is edited:");
      await tx.execute(sql`UPDATE campaigns SET brand_id = ${brandB} WHERE id = ${campId}`);
      const b = await mintDripLeadLink(tx, {
        ...base, brandId: brandB, brandLandingHost: "www.fitsyou.net",
        handEditedUrl: null, sendToken: randomUUID(),
      });
      check("minted", b.ok, true);
      if (b.ok) {
        check("⭐ the destination FOLLOWED the re-brand",
              await dest(b.linkId), `https://www.fitsyou.net/lp/${slug}?sub_id3=${tid}`);
      }

      // ── 3. HAND-EDITED ⇒ used verbatim, and does NOT follow a re-brand ────
      console.log("\n3. hand-edited (with UTM) ⇒ used verbatim:");
      const edited = `https://www.lumzen.co/lp/${slug}?sub_id3=${tid}&utm_source=x`;
      const c = await mintDripLeadLink(tx, {
        ...base, brandId: brandB, brandLandingHost: "www.fitsyou.net",
        handEditedUrl: edited, sendToken: randomUUID(),
      });
      check("minted", c.ok, true);
      if (c.ok) {
        const got = await dest(c.linkId);
        check("⭐ destination is the edited URL, byte-for-byte", got, edited);
        check("⭐ ...UTM survived (the point of allowing the edit)",
              got.includes("&utm_source=x"), true);
        check("⭐ ...and it did NOT follow the re-brand to fitsyou",
              got.includes("www.fitsyou.net"), false);
      }

      // ── 4. an edit that does NOT carry this stage's tracking id is ignored ─
      console.log("\n4. an edit missing this stage's tracking id falls back:");
      const bogus = `https://www.lumzen.co/lp/${slug}?sub_id3=SOMEONE_ELSES_ID`;
      const d = await mintDripLeadLink(tx, {
        ...base, brandId: brandB, brandLandingHost: "www.fitsyou.net",
        handEditedUrl: bogus, sendToken: randomUUID(),
      });
      check("minted", d.ok, true);
      if (d.ok) {
        check("⭐ fell back to canonical construction rather than shipping it",
              await dest(d.linkId), `https://www.fitsyou.net/lp/${slug}?sub_id3=${tid}`);
      }

      rolledBack = true;
      throw new Error("ROLLBACK");
    });
  } catch (e) {
    if ((e as Error).message !== "ROLLBACK") throw e;
  }
  check("probe rolled back", rolledBack, true);
  const left = (await db.execute(sql`
    SELECT count(*)::int AS n FROM campaigns WHERE name = 'mint honour probe'
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
