import "./_env-preload";

// PR 4d Task 3 on PRODUCTION, because preview cannot answer the question:
// preview holds 500 contacts and 320 contact_offer_campaigns rows against
// production's ~906K and ~2.5M. A 400 ms result over 500 rows says nothing
// about the planner's behaviour over 2.5M.
//
// ⭐ READ-ONLY. Every run is inside a transaction that ALWAYS rolls back, and
// the only tables created are TEMP … ON COMMIT DROP. The pool row count is
// asserted unchanged afterwards.
//
// ⚠️ WHY THIS IS WORTH A PRODUCTION READ. CLAUDE.md §10b records that folding
// the prior-offer exclusion into the qualifier produced a nested-loop anti-join
// — 115.7M heap fetches, 84 s, past the route's 60 s limit, so campaign
// creation timed out and rolled back. The Y/N rule is a SECOND anti-join over
// the same temp table and can reproduce exactly that. 4d is already merged, so
// this is not a gate any more — it is a check on something already live.
//
// Run OFF the busy cron minutes. Listed in EXCLUSIONS of
// scripts/test-preview-db-guard.ts.
//
// Run: npx tsx --conditions=react-server scripts/measure-offer-rules-activation-prod.ts

import { sql } from "drizzle-orm";

async function main() {
  const { db } = await import("@/db/client");
  const { snapshotAudience } = await import("@/lib/audience-snapshot");

  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x")
    .hostname;
  const started = new Date();
  console.log(`measuring against ${host} — READ ONLY, always rolled back`);
  console.log(`started ${started.toISOString()} (minute :${started.getUTCMinutes()})\n`);

  const poolBefore = (await db.execute(
    sql`SELECT count(*)::int AS n FROM campaign_audience_pool`,
  )) as unknown as { n: number }[];

  // A REAL recipe with a real audience: the most recent campaign that has an
  // offer, a source, and actually snapshotted something.
  const pick = (await db.execute(sql`
    SELECT c.id, c.org_id, c.offer_id, c.audience_snapshot_count,
           c.audience_segment_ids, c.audience_exclude_segment_ids,
           c.audience_contact_group_ids, c.audience_filters,
           c.exclude_in_use_contacts, c.lifecycle_rules
    FROM campaigns c
    WHERE c.offer_id IS NOT NULL
      AND c.audience_snapshot_count > 1000
      AND coalesce(array_length(c.audience_contact_group_ids, 1), 0)
        + coalesce(array_length(c.audience_segment_ids, 1), 0) > 0
    ORDER BY c.created_at DESC LIMIT 1
  `)) as unknown as Record<string, unknown>[];
  if (!pick[0]) throw new Error("no campaign with a real audience recipe");
  const c = pick[0];
  console.log(
    `recipe from campaign ${c.id} (offer ${c.offer_id}, snapshotted ${Number(c.audience_snapshot_count).toLocaleString()})`,
  );

  const base = {
    // ⚠️ A DIFFERENT campaign id than the recipe's owner, so the current-campaign
    // carve-out behaves as it would for a NEW campaign rather than excusing the
    // recipe's own history.
    campaignId: -1,
    orgId: c.org_id as string,
    segmentIds: (c.audience_segment_ids as number[]) ?? [],
    excludeSegmentIds: (c.audience_exclude_segment_ids as number[]) ?? [],
    contactGroupIds: (c.audience_contact_group_ids as number[]) ?? [],
    filters: (c.audience_filters ?? {}) as never,
    cap: null,
    // ⚠️ FORCED OFF for the measurement. With it on, the recipe's own contacts
    // are already in that campaign's active pool, so the candidate set comes
    // out EMPTY and both predicates are timed against nothing — which is how
    // the first run returned pool 0 for both. Off gives a real candidate set,
    // which is both a harder timing test and the only way the re-admitted
    // count means anything.
    excludeInUse: false,
    excludePriorOffer: true,
    offerId: c.offer_id as number,
    lifecycleRules: c.lifecycle_rules === true,
  };

  const run = async (label: string, offerRulesEnabled: boolean) => {
    let count = 0;
    let ms = 0;
    await db
      .transaction(async (tx) => {
        const t = performance.now();
        const r = await snapshotAudience(
          { ...base, offerRulesEnabled, offerCooldownDays: 7, offerLimitTimes: 5 },
          tx,
        );
        ms = performance.now() - t;
        count = r.count;
        throw new Error("__ROLLBACK__");
      })
      .catch((e) => {
        if (!(e instanceof Error) || e.message !== "__ROLLBACK__") throw e;
      });
    console.log(
      `  ${label.padEnd(40)} ${Math.round(ms).toLocaleString().padStart(8)} ms   pool ${count.toLocaleString()}`,
    );
    return { ms, count };
  };

  console.log("\nactivation, same recipe, rolled back each time:");
  await run("(warm-up, discarded)", false);
  const legacy = await run("LEGACY 'ever got this offer'", false);
  const yn = await run("Y/N offer rules (7 days / 5 campaigns)", true);

  const delta = yn.ms - legacy.ms;
  console.log(
    `\ndelta: ${delta >= 0 ? "+" : ""}${Math.round(delta).toLocaleString()} ms` +
      ` (${((yn.ms / legacy.ms - 1) * 100).toFixed(1)}%)`,
  );
  console.log(
    `bar: the route's limit is 60 s and the recorded good state is ~4.2 s.` +
      ` Y/N at ${(yn.ms / 1000).toFixed(1)} s ⇒ ${yn.ms < 10_000 ? "FINE" : "⛔ INVESTIGATE"}`,
  );
  console.log(
    `\n⭐ re-admitted by Y/N that 'ever got' excluded forever: ` +
      `${(yn.count - legacy.count).toLocaleString()} ` +
      `(${legacy.count.toLocaleString()} → ${yn.count.toLocaleString()})`,
  );

  const poolAfter = (await db.execute(
    sql`SELECT count(*)::int AS n FROM campaign_audience_pool`,
  )) as unknown as { n: number }[];
  const same = poolBefore[0].n === poolAfter[0].n;
  console.log(
    `\ncampaign_audience_pool: ${poolBefore[0].n.toLocaleString()} → ${poolAfter[0].n.toLocaleString()}` +
      ` ${same ? "✓ unchanged" : "✗ CHANGED — INVESTIGATE"}`,
  );
  console.log(`finished ${new Date().toISOString()}`);
  process.exit(same ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
