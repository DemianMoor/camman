import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// TASK 3 (per-offer conversion attribution): the one-shot backfill that moves
// existing conversion_events rows to the offer mapped from their Keitaro offer.
//
// Calls the backfill's core, runOfferBackfill, inside ONE transaction that is
// always rolled back (no residue on camman-v2). "Dry run" = the core inside a
// savepoint that is rolled back; "apply" = the core in the outer transaction.
//
//   B1 dry run: exactly 1 row A→B; shared Keitaro id and campaign-less rows untouched
//   B2 dry run: per-campaign totals and targeting (buyers + segment rule) identical
//   B3 apply moves exactly 1; a second dry run reports 0
//   B4 the reverse direction: unlinking B sends the row back to the campaign offer A
//   B5 --links: a valid pair links + moves; a pair that updates 0 rows fails
//   B6 the CLI: --links without --org, a 0-row pair → exit 1; a plain dry run → exit 0
//   B7 isolation: the core refuses anything below REPEATABLE READ (the CLI runs RR — B6's exit 0)
//   B8 source: the campaign join and the moves join are org-scoped
//
// Run (preview DB only):
//   DATABASE_URL="$(grep '^DATABASE_URL=' .env.demo | cut -d= -f2- | tr -d '\r\"')" \
//     npx tsx --conditions=react-server scripts/test-offer-attribution-backfill-db.ts

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { sql, type SQL } from "drizzle-orm";

const MARKER = "__OFFER_ATTRIBUTION_BACKFILL_TEST__";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

class Rollback extends Error {}

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } = await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const { runOfferBackfill } = await import("./backfill-conversion-offer-attribution");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const phones = fictionalPhones(3);
  await refuseIfPhonesInUse(db, phones);

  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  const quiet = () => {};

  try {
    await db.transaction(async (tx: Tx) => {
      const one = async <T>(q: SQL): Promise<T> =>
        ((await tx.execute(q)) as unknown as T[])[0];
      // A dry run: the core inside a savepoint that is always rolled back.
      const dry = async (
        opts: Omit<Parameters<typeof runOfferBackfill>[1], "orgId" | "log"> & { orgId?: string | null },
        prep?: (sp: Tx) => Promise<void>,
      ) => {
        let res: Awaited<ReturnType<typeof runOfferBackfill>> | undefined;
        try {
          await tx.transaction(async (sp) => {
            if (prep) await prep(sp);
            res = await runOfferBackfill(sp, { orgId, ...opts, log: quiet });
            throw new Rollback();
          });
        } catch (e) {
          if (!(e instanceof Rollback)) throw e;
        }
        return res!;
      };

      const tag = `oab-${Date.now()}`;
      // Keitaro ids far outside anything real, so no live offer shares them.
      const base = 900_000_000 + Math.floor(Math.random() * 90_000_000);
      const kA = base, kB = base + 1, kShared = base + 2, kD = base + 3, kNone = base + 4;

      const mkOrg = async (s: string) =>
        (await one<{ id: string }>(sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag} ${s}`}) RETURNING id`)).id;
      const orgId = await mkOrg("main");
      const otherOrg = await mkOrg("other");

      const mkOfferFor = async (org: string, s: string, keitaro: number | null) => {
        const net = await one<{ id: number }>(
          sql`INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${org}::uuid, ${`n${s}-${tag}`}, ${`N${s} ${tag}`}) RETURNING id`,
        );
        return (
          await one<{ id: number }>(sql`
            INSERT INTO offers (org_id, offer_id, network_id, name, keitaro_offer_id)
            VALUES (${org}::uuid, ${`o${s}-${tag}`}, ${net.id}, ${`O${s} ${tag}`}, ${keitaro}) RETURNING id`)
        ).id;
      };
      const offerA = await mkOfferFor(orgId, "a", kA);
      const offerB = await mkOfferFor(orgId, "b", kB);
      const offerC = await mkOfferFor(orgId, "c", kShared); // shares its id with offer X
      const offerD = await mkOfferFor(orgId, "d", null); // linked only by --links
      await mkOfferFor(otherOrg, "x", kShared);

      const brand = await one<{ id: number }>(
        sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}::uuid, ${`b-${tag}`}, ${`B ${tag}`}) RETURNING id`,
      );
      const et = await one<{ id: number }>(sql`
        INSERT INTO event_types (org_id, key, label, is_purchase, counts_revenue)
        VALUES (${orgId}::uuid, 'sale', 'Sale', true, true) RETURNING id`);
      const camp = (
        await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, offer_id)
          VALUES (${orgId}::uuid, ${`c-${tag}`}, ${`C ${tag}`}, 'active', 'manual', ${brand.id}, ${offerA})
          RETURNING id`)
      ).id;
      const stage = (
        await one<{ id: number }>(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, stop_text)
          VALUES (${orgId}::uuid, ${camp}, 1, 'STOP') RETURNING id`)
      ).id;
      const contacts: string[] = [];
      for (const p of phones) {
        contacts.push(
          (await one<{ id: string }>(sql`
            INSERT INTO contacts (org_id, phone_number, lifecycle_status, line_type)
            VALUES (${orgId}::uuid, ${p}, 'cold', 'mobile') RETURNING id`)).id,
        );
      }
      // A segment with a made_purchase_for_offer rule on B — captured by the core.
      const seg = await one<{ id: number }>(
        sql`INSERT INTO segments (org_id, segment_id, name) VALUES (${orgId}::uuid, ${`s-${tag}`}, 'oab') RETURNING id`,
      );
      await tx.execute(sql`
        INSERT INTO segment_rules (org_id, segment_id, rule_type, operator, value, position)
        VALUES (${orgId}::uuid, ${seg.id}, 'made_purchase_for_offer', 'is', to_jsonb(${offerB}::int), 0)`);

      const row = async (key: string, contact: string, keitaro: number | null, onCampaign: boolean, revenue: string) =>
        (
          await one<{ id: number }>(sql`
            INSERT INTO conversion_events
              (org_id, keitaro_event_id, keitaro_status, keitaro_type, keitaro_offer_id, contact_id,
               campaign_id, stage_id, offer_id, event_type_id, status, revenue, occurred_at)
            VALUES (${orgId}::uuid, ${`${tag}-${key}`}, 'sale', 'sale', ${keitaro}, ${contact}::uuid,
                    ${onCampaign ? camp : null}, ${onCampaign ? stage : null}, ${offerA}, ${et.id},
                    'approved', ${revenue}::numeric, now())
            RETURNING id`)
        ).id;
      await row("a1", contacts[0], kA, true, "10.0000");
      await row("a2", contacts[1], kA, true, "20.0000");
      const rowB = await row("b1", contacts[2], kB, true, "30.0000"); // the one that moves
      await row("shared", contacts[0], kShared, true, "5.0000"); // id on 2 offers → stays on A
      const rowNoCamp = await row("nocamp", contacts[1], kB, false, "7.0000"); // no campaign → stays
      const rowD = await row("d1", contacts[2], kD, true, "3.0000"); // unmapped until --links
      await row("none", contacts[0], kNone, true, "1.0000"); // never mapped
      const offerOf = async (id: number) =>
        (await one<{ o: number }>(sql`SELECT offer_id AS o FROM conversion_events WHERE id = ${id}`)).o;

      // ── B1/B2 dry run ──────────────────────────────────────────────────────
      console.log("B1/B2 dry run");
      const r1 = await dry({ links: [] });
      bar("dry run passes every assertion", r1.ok, r1.failures.join("; "));
      bar("exactly 1 row moves", r1.moveCount === 1, `moveCount=${r1.moveCount}`);
      const g = r1.groups[0];
      bar(
        "the move is A→B for Keitaro offer kB, 1 row, 1 sale, $30",
        r1.groups.length === 1 && g.fromOffer === offerA && g.toOffer === offerB &&
          g.keitaroOfferId === kB && g.rows === 1 && g.sales === 1 && Number(g.approvedRevenue) === 30,
        JSON.stringify(r1.groups),
      );
      bar("shared Keitaro id (offer C + other-org X) is not used", !r1.groups.some((x) => x.toOffer === offerC));
      bar("the dry run left the row on A", (await offerOf(rowB)) === offerA);
      bar("per-campaign totals identical", r1.campaignTotalsIdentical && r1.campaignsCompared >= 1, `campaigns=${r1.campaignsCompared}`);
      const buyersB = r1.targeting.find((t) => t.kind === "offer" && t.id === offerB);
      const buyersA = r1.targeting.find((t) => t.kind === "offer" && t.id === offerA);
      const rule = r1.targeting.find((t) => t.kind === "segment_rule");
      bar(
        "targeting captured non-vacuously: A's buyers = 3 (campaign offer), B's = 0, segment rule on B = 0",
        buyersA?.before === 3 && buyersB?.before === 0 && rule?.before === 0,
        JSON.stringify(r1.targeting),
      );
      bar("targeting identical before/after", r1.targeting.length >= 3 && r1.targeting.every((t) => t.identical));

      // ── B3 apply + second dry run ─────────────────────────────────────────
      console.log("\nB3 apply, then a second dry run");
      const r2 = await runOfferBackfill(tx, { orgId, links: [], log: quiet });
      bar("apply passes every assertion", r2.ok, r2.failures.join("; "));
      bar("apply moved exactly 1", r2.updated === 1 && r2.moveCount === 1, `updated=${r2.updated}`);
      bar("the row is now on B", (await offerOf(rowB)) === offerB);
      bar("the campaign-less row kept its offer", (await offerOf(rowNoCamp)) === offerA);
      const r3 = await dry({ links: [] });
      bar("second dry run reports 0", r3.ok && r3.moveCount === 0, `moveCount=${r3.moveCount}`);

      // ── B4 reverse direction ──────────────────────────────────────────────
      console.log("\nB4 reverse direction");
      const r4 = await dry({ links: [] }, async (sp) => {
        await sp.execute(sql`UPDATE offers SET keitaro_offer_id = NULL WHERE id = ${offerB}`);
      });
      bar(
        "unlinking B moves the row back B→A",
        r4.ok && r4.moveCount === 1 && r4.groups[0]?.fromOffer === offerB && r4.groups[0]?.toOffer === offerA,
        JSON.stringify(r4.groups),
      );

      // ── B5 --links ────────────────────────────────────────────────────────
      console.log("\nB5 --links");
      const r5 = await dry({ links: [{ keitaroOfferId: kD, offerId: offerD }] });
      bar(
        "a valid pair links D and moves its row A→D",
        r5.ok && r5.linked === 1 && r5.moveCount === 1 && r5.groups[0]?.toOffer === offerD,
        JSON.stringify(r5.groups),
      );
      bar("the dry run did not keep the link", (await one<{ k: number | null }>(sql`SELECT keitaro_offer_id AS k FROM offers WHERE id = ${offerD}`)).k === null);
      bar("…nor the move", (await offerOf(rowD)) === offerA);
      const r6 = await dry({ links: [{ keitaroOfferId: kNone, offerId: offerA }] }); // A already linked
      bar("a pair on an already-linked offer fails", !r6.ok && r6.moveCount === 0, r6.failures.join("; "));
      const r7 = await dry({ links: [{ keitaroOfferId: kNone, offerId: -1 }] }); // no such offer
      bar("a pair on a missing offer fails", !r7.ok, r7.failures.join("; "));
      const r8 = await dry({ links: [{ keitaroOfferId: kD, offerId: offerD }], orgId: null });
      bar("--links without --org is refused, nothing linked", !r8.ok && r8.linked === 0 && /requires --org/.test(r8.failures.join()), r8.failures.join("; "));
      const r9 = await dry({ links: [{ keitaroOfferId: kShared, offerId: offerD }] }); // carried by C and X
      bar("a Keitaro id another offer already carries is refused, nothing linked", !r9.ok && r9.linked === 0 && /already carried/.test(r9.failures.join()), r9.failures.join("; "));
      const r10 = await dry({ links: [{ keitaroOfferId: kD, offerId: offerD }, { keitaroOfferId: kD, offerId: offerC }] });
      bar("the same Keitaro id twice in --links is refused", !r10.ok && r10.linked === 1, r10.failures.join("; "));

      // ── B7 isolation (this transaction is REPEATABLE READ) ────────────────
      console.log("\nB7 isolation");
      bar("the core reports repeatable read", r1.isolation === "repeatable read", r1.isolation);

      throw new Rollback();
    }, { isolationLevel: "repeatable read" });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  let rc: Awaited<ReturnType<typeof runOfferBackfill>> | undefined;
  try {
    await db.transaction(async (tx: Tx) => {
      rc = await runOfferBackfill(tx, { orgId: randomUUID(), links: [], log: quiet });
      throw new Rollback();
    }); // default: READ COMMITTED
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  bar("the core refuses READ COMMITTED", !rc!.ok && /repeatable read/.test(rc!.failures.join()), rc!.failures.join("; "));

  // ── B8 source: org-scoped joins (a cross-org campaign fixture is impractical) ─
  console.log("\nB8 source");
  const src = readFileSync("scripts/backfill-conversion-offer-attribution.ts", "utf8");
  bar("campaign join is org-scoped", src.includes("JOIN campaigns ca ON ca.id = ce.campaign_id AND ca.org_id = ce.org_id"));
  bar("moves → conversion_events joins are org-scoped", (src.match(/ce\.id = m\.id AND ce\.org_id = m\.org_id/g) ?? []).length === 2);
  bar("the CLI transaction is repeatable read", /isolationLevel: "repeatable read"/.test(src));

  // ── B6 the CLI's exit code ────────────────────────────────────────────────
  console.log("\nB6 CLI");
  // Same DATABASE_URL (the preview DB this process was refused anything else for).
  const runCli = (args: string) =>
    spawnSync(`npx tsx --conditions=react-server scripts/backfill-conversion-offer-attribution.ts ${args}`, {
      encoding: "utf8",
      env: process.env,
      shell: true,
    });
  const noOrg = runCli("--links 999999999:-1");
  bar("CLI: --links without --org exits 1, nothing written", noOrg.status === 1 && /requires --org/.test(noOrg.stdout) && /nothing written/.test(noOrg.stdout), `status=${noOrg.status}`);
  const okDry = runCli("");
  bar("CLI: a plain dry run exits 0 (so its transaction passed the RR check)", okDry.status === 0 && /DRY RUN — rolled back/.test(okDry.stdout), `status=${okDry.status} ${okDry.stderr.slice(0, 300)}`);
  const cli = runCli("--org 00000000-0000-0000-0000-000000000000 --links 999999999:-1");
  bar("CLI exits 1 on a --links pair that updates 0 rows", cli.status === 1, `status=${cli.status}${cli.status === 1 ? "" : ` ${cli.stderr.slice(0, 300)}`}`);
  bar("…and says it rolled back", /rolled back/i.test(cli.stdout), cli.stdout.trim().split("\n").slice(-2).join(" | "));

  const residue = await db.execute(sql`SELECT count(*)::int AS n FROM organizations WHERE name LIKE ${`${MARKER}%`}`);
  bar("no fixture residue", (residue as unknown as { n: number }[])[0].n === 0);

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
