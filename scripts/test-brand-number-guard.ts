import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  checkPhoneBrandMatch,
  pairIsChanging,
} from "@/lib/api/brand-number-guard";
import {
  computeBrandChangeImpact,
  isStageNumberBrandStale,
} from "@/lib/api/campaign-brand-change";

// Guard for the brand → sending-number rule (Drip Phase 1, item 1a).
//
// ⭐ It asserts BOTH directions, deliberately. A test that only proves
// "a mismatch is rejected" would still pass if the guard rejected everything;
// a test that only proves "a match is allowed" would pass if it allowed
// everything. The interesting failure is the guard silently degrading to one
// of those, so every case below states which way it must go and why.
//
// ⭐ It also proves the guard can go RED. The negative cases are built from a
// REAL mismatched pair that exists in production today (phone 114 is a LumZen
// number used by Guide Kin campaigns, left in place by product ruling), not
// from a synthesized fixture — so this cannot quietly become a tautology if
// the data changes underneath it. If that pair is ever cleaned up, the script
// says so and exits non-zero rather than passing on an empty world.
//
// Read-only. Writes nothing.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  const orgRows = (await db.execute(
    sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`,
  )) as unknown as { id: string }[];
  const orgId = orgRows[0]?.id;
  if (!orgId) throw new Error("no organization found");

  // ── Input scope: say what this ran against, so a PASS means something ──────
  const pairs = (await db.execute(sql`
    SELECT pp.id   AS phone_id,
           pp.phone_number,
           pp.brand_id AS phone_brand_id,
           pb.name  AS phone_brand,
           c.brand_id AS campaign_brand_id,
           cb.name  AS campaign_brand,
           count(*)::int AS stages
    FROM campaign_stages s
    JOIN provider_phones pp ON pp.id = s.provider_phone_id
    JOIN campaigns c        ON c.id  = s.campaign_id
    LEFT JOIN brands pb ON pb.id = pp.brand_id
    LEFT JOIN brands cb ON cb.id = c.brand_id
    WHERE pp.org_id = ${orgId}
      AND pp.brand_id IS DISTINCT FROM c.brand_id
    GROUP BY 1,2,3,4,5,6
    ORDER BY 7 DESC
  `)) as unknown as {
    phone_id: number;
    phone_number: string;
    phone_brand_id: number;
    phone_brand: string;
    campaign_brand_id: number;
    campaign_brand: string;
    stages: number;
  }[];

  console.log(`org ${orgId}`);
  console.log(`legacy mismatched (phone, campaign-brand) pairs in production: ${pairs.length}`);
  for (const p of pairs) {
    console.log(
      `  phone ${p.phone_id} ${p.phone_number} [${p.phone_brand}] used by ${p.campaign_brand} campaigns — ${p.stages} stage(s)`,
    );
  }
  if (pairs.length === 0) {
    console.error(
      "\nFAIL: no mismatched pair exists any more, so the negative cases below " +
        "would be vacuous. Rewrite this guard against a synthesized-then-rolled-back " +
        "pair before trusting a PASS.",
    );
    process.exit(1);
  }

  const mism = pairs[0];

  // ── Negative: the real mismatch MUST be rejected ──────────────────────────
  console.log("\nrejects a real cross-brand pairing:");
  const bad = await checkPhoneBrandMatch(db, {
    orgId,
    providerPhoneId: mism.phone_id,
    campaignBrandId: mism.campaign_brand_id,
  });
  check("returns a mismatch (not null)", bad !== null, true);
  check("names the phone's brand", bad?.phoneBrandId, mism.phone_brand_id);
  check("names the campaign's brand", bad?.campaignBrandId, mism.campaign_brand_id);
  check(
    "message names BOTH brands and the number",
    !!bad &&
      bad.message.includes(mism.phone_number) &&
      bad.message.includes(mism.phone_brand) &&
      bad.message.includes(mism.campaign_brand),
    true,
  );
  if (bad) console.log(`        message: ${bad.message}`);

  // ── Positive: the SAME phone against its OWN brand must be allowed ────────
  // This is the case that catches a guard which rejects everything.
  console.log("\nallows the same number against its own brand:");
  const good = await checkPhoneBrandMatch(db, {
    orgId,
    providerPhoneId: mism.phone_id,
    campaignBrandId: mism.phone_brand_id,
  });
  check("returns null", good, null);

  // ── Absent = allowed, both flavours ──────────────────────────────────────
  console.log("\nabsent = allowed:");
  check(
    "no number chosen ⇒ allowed",
    await checkPhoneBrandMatch(db, {
      orgId,
      providerPhoneId: null,
      campaignBrandId: mism.campaign_brand_id,
    }),
    null,
  );
  check(
    "campaign has no brand yet ⇒ allowed (drafts save with nothing set)",
    await checkPhoneBrandMatch(db, {
      orgId,
      providerPhoneId: mism.phone_id,
      campaignBrandId: null,
    }),
    null,
  );

  // A NULL-brand ("shared") number must be allowed for ANY brand. No such row
  // exists today, so this is proven against a rolled-back synthesized one —
  // otherwise the rule would be untested until the day someone relies on it.
  console.log("\nshared (NULL-brand) number is allowed for any brand:");
  // Capture the verdict in an OUTER variable: tx.rollback() throws by design,
  // so anything returned from inside the callback is discarded.
  let sharedVerdict: unknown = "not-run";
  let rolledBack = false;
  try {
    await db.transaction(async (tx) => {
      const src = (await tx.execute(sql`
        SELECT provider_id FROM provider_phones WHERE id = ${mism.phone_id}
      `)) as unknown as { provider_id: number }[];
      const ins = (await tx.execute(sql`
        INSERT INTO provider_phones (org_id, provider_id, brand_id, phone_number, status, cost_per_sms)
        VALUES (${orgId}, ${src[0].provider_id}, NULL, ${"+1999" + String(Date.now()).slice(-7)}, 'active', 0)
        RETURNING id
      `)) as unknown as { id: number }[];
      sharedVerdict = await checkPhoneBrandMatch(tx, {
        orgId,
        providerPhoneId: ins[0].id,
        campaignBrandId: mism.campaign_brand_id,
      });
      tx.rollback(); // never persist the probe row
    });
  } catch (e) {
    // Drizzle signals an intentional rollback by throwing; match on the
    // constructor, not `.name` (which reads "DrizzleError").
    const ctor = (e as { constructor?: { name?: string } })?.constructor?.name;
    if (ctor === "TransactionRollbackError") rolledBack = true;
    else throw e;
  }
  check("shared number allowed for a DIFFERENT brand ⇒ null", sharedVerdict, null);
  check("probe transaction rolled back (nothing persisted)", rolledBack, true);
  const leaked = (await db.execute(sql`
    SELECT count(*)::int AS n FROM provider_phones WHERE org_id = ${orgId} AND brand_id IS NULL
  `)) as unknown as { n: number }[];
  check("no NULL-brand phone left behind", leaked[0]?.n, 0);

  // ── Grandfathering: the mechanism that keeps legacy pairs editable ────────
  console.log("\ngrandfathering (pairIsChanging):");
  check(
    "neither field in the patch ⇒ not changing (legacy pair stays editable)",
    pairIsChanging({ nextPhoneId: undefined, currentPhoneId: 114, nextBrandId: undefined, currentBrandId: 8 }),
    false,
  );
  check(
    "same number re-sent ⇒ not changing",
    pairIsChanging({ nextPhoneId: 114, currentPhoneId: 114, nextBrandId: undefined, currentBrandId: 8 }),
    false,
  );
  check(
    "number changed ⇒ changing",
    pairIsChanging({ nextPhoneId: 27, currentPhoneId: 114, nextBrandId: undefined, currentBrandId: 8 }),
    true,
  );
  check(
    "brand changed ⇒ changing (the other side of the pair)",
    pairIsChanging({ nextPhoneId: undefined, currentPhoneId: 114, nextBrandId: 142, currentBrandId: 8 }),
    true,
  );
  check(
    "explicit null clears the number ⇒ changing",
    pairIsChanging({ nextPhoneId: null, currentPhoneId: 114, nextBrandId: undefined, currentBrandId: 8 }),
    true,
  );


  // ── The rebrand rule (1b ruling, folded into 1a's guard set) ──────────────
  //
  // A campaign's brand MAY change. What must not happen is the change silently
  // leaving its stages on the old brand's number. 1a alone cannot catch this: it
  // grandfathers by "the (brand, number) pair is not changing", which is true of
  // the campaign row and says nothing about its stages — exactly how campaigns
  // 902 and 923 were re-branded in production on 2026-08-22 with stale stages.
  //
  // ⭐ Asserted on a SYNTHESIZED, ROLLED-BACK world, not on live rows. Per the
  // standing rule, a live or active-campaign entity is never a test fixture.
  // Synthesizing also lets the guard PROVE IT CAN GO RED: the same stage is
  // asserted clean under one brand and stale under another, so a function that
  // always returned `stale:false` (or always `true`) fails here.
  console.log("\nrebrand rule — a stale sending number blocks approval:");
  const brandRows = (await db.execute(sql`
    SELECT id FROM brands WHERE org_id = ${orgId} AND status = 'active' ORDER BY id LIMIT 2
  `)) as unknown as { id: number }[];
  if (brandRows.length < 2) {
    console.log("  FAIL  needs two active brands to model a rebrand");
    failures++;
  } else {
    const brandA = brandRows[0].id;
    const brandB = brandRows[1].id;
    console.log(`        modelling a rebrand from brand ${brandA} to brand ${brandB}`);

    const probe: Record<string, unknown> = {};
    let rebrandRolledBack = false;
    try {
      await db.transaction(async (tx) => {
        const prov = (await tx.execute(sql`
          SELECT provider_id FROM provider_phones WHERE org_id = ${orgId} LIMIT 1
        `)) as unknown as { provider_id: number }[];
        const providerId = prov[0].provider_id;
        const uniq = String(Date.now()).slice(-6);

        const mkPhone = async (brandId: number | null, tag: string) =>
          ((await tx.execute(sql`
            INSERT INTO provider_phones (org_id, provider_id, brand_id, phone_number, status, cost_per_sms)
            VALUES (${orgId}, ${providerId}, ${brandId}, ${"+1998" + tag + uniq}, 'active', 0)
            RETURNING id`)) as unknown as { id: number }[])[0].id;

        const phoneA = await mkPhone(brandA, "1");
        const phoneShared = await mkPhone(null, "2");

        const camp = ((await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name, status, brand_id)
          VALUES (${orgId}, ${"rbp-" + uniq}, 'rebrand probe', 'draft', ${brandA})
          RETURNING id`)) as unknown as { id: number }[])[0].id;

        const mkStage = async (n: number, phoneId: number | null, fullUrl: string | null) =>
          ((await tx.execute(sql`
            INSERT INTO campaign_stages (org_id, campaign_id, stage_number, provider_phone_id, full_url)
            VALUES (${orgId}, ${camp}, ${n}, ${phoneId}, ${fullUrl})
            RETURNING id`)) as unknown as { id: number }[])[0].id;

        const stageOnA = await mkStage(1, phoneA, "https://www.example.com/lp/x?sub_id3=T");
        const stageShared = await mkStage(2, phoneShared, null);
        const stageNoNumber = await mkStage(3, null, null);

        // Before the rebrand: consistent.
        probe.beforeStale = (await isStageNumberBrandStale(tx, { orgId, stageId: stageOnA })).stale;

        // The rebrand: the campaign moves to brand B. The stage's number does not.
        await tx.execute(sql`UPDATE campaigns SET brand_id = ${brandB} WHERE id = ${camp}`);
        const after = await isStageNumberBrandStale(tx, { orgId, stageId: stageOnA });
        probe.afterStale = after.stale;
        probe.afterNamesBothBrands =
          !!after.message && /registered to/.test(after.message) && /brand is now/.test(after.message);

        // "Absent = allowed" — the same reading 1a and the carrier policy use.
        probe.sharedNumberStale = (await isStageNumberBrandStale(tx, { orgId, stageId: stageShared })).stale;
        probe.noNumberStale = (await isStageNumberBrandStale(tx, { orgId, stageId: stageNoNumber })).stale;

        // The warning must AGREE with the block. A warning that disagrees with
        // what is actually enforced is worse than no warning at all.
        const toB = await computeBrandChangeImpact(tx, { orgId, campaignId: camp, newBrandId: brandB });
        const toA = await computeBrandChangeImpact(tx, { orgId, campaignId: camp, newBrandId: brandA });
        const toNull = await computeBrandChangeImpact(tx, { orgId, campaignId: camp, newBrandId: null });
        probe.impactToBListsStage = toB.staleNumberStages.some((s) => s.stage_id === stageOnA);
        probe.impactToAIsClean = !toA.staleNumberStages.some((s) => s.stage_id === stageOnA);
        probe.impactNullEmpty = toNull.staleNumberStages.length === 0;
        probe.impactSkipsSharedNumber = !toB.staleNumberStages.some((s) => s.stage_id === stageShared);
        probe.impactSkipsNoNumber = !toB.staleNumberStages.some((s) => s.stage_id === stageNoNumber);

        // The destination half: a legacy frozen URL is warned about; a stage with
        // no frozen URL is not, because mint-time construction self-corrects.
        probe.legacyUrlWarned = toB.legacyDestinationStages.some((s) => s.stage_id === stageOnA);
        probe.noUrlNotWarned = !toB.legacyDestinationStages.some((s) => s.stage_id === stageNoNumber);

        tx.rollback();
      });
    } catch (e) {
      const ctor = (e as { constructor?: { name?: string } })?.constructor?.name;
      if (ctor === "TransactionRollbackError") rebrandRolledBack = true;
      else throw e;
    }

    check("consistent stage before the rebrand ⇒ not stale", probe.beforeStale, false);
    check("SAME stage after the rebrand ⇒ stale (proves it can go RED)", probe.afterStale, true);
    check("message names the number's brand and the campaign's new brand", probe.afterNamesBothBrands, true);
    check("shared (NULL-brand) number ⇒ not stale (absent = allowed)", probe.sharedNumberStale, false);
    check("stage with no number ⇒ not stale (nothing to mismatch)", probe.noNumberStale, false);
    check("impact→new brand lists the stale stage", probe.impactToBListsStage, true);
    check("impact→its own brand lists nothing (not a blanket reject)", probe.impactToAIsClean, true);
    check("impact→NULL brand is empty (nothing to match against)", probe.impactNullEmpty, true);
    check("impact skips a shared number", probe.impactSkipsSharedNumber, true);
    check("impact skips a stage with no number", probe.impactSkipsNoNumber, true);
    check("legacy frozen full_url IS warned about", probe.legacyUrlWarned, true);
    check("stage with no destination is NOT warned about", probe.noUrlNotWarned, true);
    check("rebrand probe rolled back (nothing persisted)", rebrandRolledBack, true);

    const residue = (await db.execute(sql`
      SELECT count(*)::int AS n FROM campaigns WHERE org_id = ${orgId} AND slug LIKE 'rbp-%'
    `)) as unknown as { n: number }[];
    check("no probe campaign left behind", residue[0]?.n, 0);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
