import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  checkPhoneBrandMatch,
  pairIsChanging,
} from "@/lib/api/brand-number-guard";

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

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
