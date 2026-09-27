import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// PR 4d Task 3: does replacing the permanent "ever got this offer" DELETE with
// the Y/N rule cost anything at activation?
//
// ⚠️ THE NUMBER THAT MATTERS IS 4.2s. CLAUDE.md §10b records that folding this
// exclusion into the qualifier produced a nested-loop anti-join — 115.7M heap
// fetches, 84s, past the route's 60s limit, so campaign creation timed out and
// rolled back. Splitting it into its own statement after ANALYZE fixed it.
// The new predicate is a SECOND anti-join over the same temp table, so it can
// reproduce that failure. A regression here is a campaign-creation outage.
//
// Read-only: every run is inside a transaction that always rolls back, and
// snapshotAudience only creates TEMP … ON COMMIT DROP tables.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/measure-offer-rules-activation.ts

import { sql } from "drizzle-orm";

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const { snapshotAudience } = await import("@/lib/audience-snapshot");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  // A real recipe: the campaign with the biggest group audience on preview.
  const pick = (await db.execute(sql`
    SELECT c.id, c.org_id, c.offer_id,
           c.audience_segment_ids, c.audience_exclude_segment_ids,
           c.audience_contact_group_ids, c.audience_filters,
           c.exclude_in_use_contacts
    FROM campaigns c
    WHERE c.offer_id IS NOT NULL
      AND coalesce(array_length(c.audience_contact_group_ids, 1), 0)
        + coalesce(array_length(c.audience_segment_ids, 1), 0) > 0
    ORDER BY c.created_at DESC LIMIT 1
  `)) as unknown as Record<string, unknown>[];
  if (!pick[0]) throw new Error("no campaign with an audience recipe on preview");
  const c = pick[0];
  console.log(`recipe from campaign ${c.id}, offer ${c.offer_id}`);

  const base = {
    campaignId: c.id as number,
    orgId: c.org_id as string,
    segmentIds: (c.audience_segment_ids as number[]) ?? [],
    excludeSegmentIds: (c.audience_exclude_segment_ids as number[]) ?? [],
    contactGroupIds: (c.audience_contact_group_ids as number[]) ?? [],
    filters: (c.audience_filters ?? {}) as never,
    cap: null,
    excludeInUse: c.exclude_in_use_contacts as boolean,
    excludePriorOffer: true,
    offerId: c.offer_id as number,
    lifecycleRules: true,
  };

  const run = async (label: string, offerRulesEnabled: boolean) => {
    let count = 0;
    let ms = 0;
    await db
      .transaction(async (tx) => {
        const t = performance.now();
        const r = await snapshotAudience(
          {
            ...base,
            offerRulesEnabled,
            offerCooldownDays: 7,
            offerLimitTimes: 5,
          },
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
  // Warm the caches first so the comparison is like-for-like rather than
  // measuring which one ran second.
  await run("(warm-up, discarded)", false);
  const legacy = await run("LEGACY 'ever got this offer'", false);
  const yn = await run("Y/N offer rules (7 days / 5 campaigns)", true);

  const delta = yn.ms - legacy.ms;
  console.log(
    `\ndelta: ${delta >= 0 ? "+" : ""}${Math.round(delta).toLocaleString()} ms` +
      `  (${legacy.ms > 0 ? ((yn.ms / legacy.ms - 1) * 100).toFixed(1) : "—"}%)`,
  );
  console.log(
    `⚠️ the bar is the 60s route limit, and the recorded good state is ~4.2s.` +
      ` Y/N at ${(yn.ms / 1000).toFixed(1)}s ⇒ ${yn.ms < 10_000 ? "FINE" : "INVESTIGATE"}.`,
  );

  // ⭐ The number that says whether the feature does anything: contacts the
  // Y/N rule re-admits that "ever got" would have excluded forever.
  console.log(
    `\nre-admitted by Y/N vs 'ever got': ${(yn.count - legacy.count).toLocaleString()}` +
      ` (${legacy.count.toLocaleString()} → ${yn.count.toLocaleString()})`,
  );

  console.log("\nRolled back. Nothing was written.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
