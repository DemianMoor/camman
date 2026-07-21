// Proves the fix: the FROZEN snapshot now bakes in the prior-offer exclusion
// (content-dedup LAYER 3), so the frozen pool == the previewed will-send. No
// surprise second filter when the stage materializes.
//
// For a real campaign recipe with an offer that has prior exposures:
//   1. previewAudience(ON).total_matching  == snapshotAudience(ON) total  (fix: they now agree)
//   2. previewAudience(OFF).total_matching == snapshotAudience(OFF) total (regression: OFF unchanged)
//   3. ON total < OFF total                                                (it actually excludes)
// snapshotAudience runs inside a transaction that is ALWAYS rolled back — no pool
// rows are written. Read-only overall. Run: npx tsx scripts/test-snapshot-prior-offer.ts
import { config } from "dotenv";
import { createRequire } from "node:module";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
const req = createRequire(import.meta.url);
try {
  const p = req.resolve("server-only");
  // @ts-expect-error minimal Module cache entry
  req.cache[p] = { id: p, filename: p, loaded: true, exports: {} };
} catch { /* noop */ }

class Rollback extends Error {}

async function main() {
  const { previewAudience, snapshotAudience } = await import("@/lib/audience-snapshot");
  type AudienceSnapshotInput = Parameters<typeof snapshotAudience>[0];
  const { db, sql: raw } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");

  async function snapshotTotalRolledBack(input: AudienceSnapshotInput): Promise<number> {
    let total = 0;
    try {
      await db.transaction(async (tx) => {
        const snap = await snapshotAudience(input, tx);
        total = snap.total_matching;
        throw new Rollback(); // discard any inserted rows
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    return total;
  }

  let failures = 0;
  const eq = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) console.log(`  ✓ ${m}`);
    else {
      failures++;
      console.error(`  ✗ ${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    }
  };
  const ok = (c: boolean, m: string) => eq(!!c, true, m);

  // Deterministic fixture: a (contact group, offer) pair with the MOST overlap
  // between the group's members and that offer's prior exposures. This gives a
  // stable, non-empty audience where LAYER 3 has real leads to remove — unlike a
  // stored campaign whose time-based segment rules drift over time. Use a dummy
  // campaignId (0) so the current campaign never self-collides via in-use; we
  // disable excludeInUse anyway and roll the snapshot back.
  const pair = (await db.execute(sql`
    SELECT ccg.contact_group_id AS group_id, oe.offer_id, oe.org_id,
           count(*)::int AS overlap
    FROM contact_contact_groups ccg
    JOIN offer_exposures oe ON oe.contact_id = ccg.contact_id
    GROUP BY ccg.contact_group_id, oe.offer_id, oe.org_id
    ORDER BY overlap DESC
    LIMIT 1
  `)) as unknown as {
    group_id: number;
    offer_id: number;
    org_id: string;
    overlap: number;
  }[];

  if (pair.length === 0) {
    console.log("No (contact group ∩ offer-exposure) overlap found — skipping (inconclusive).");
    await raw.end({ timeout: 5 });
    process.exit(0);
  }

  const f = pair[0];
  console.log(`Using contact group ${f.group_id} ∩ offer ${f.offer_id} (overlap ${f.overlap})`);

  // A real campaign id in the org to satisfy the pool FK (the snapshot inserts
  // then rolls back; on-conflict-do-nothing means an active campaign's existing
  // rows are untouched). total_matching is computed pre-insert regardless.
  const campRow = (await db.execute(sql`
    SELECT id FROM campaigns WHERE org_id = ${f.org_id}::uuid ORDER BY created_at DESC LIMIT 1
  `)) as unknown as { id: number }[];
  const campaignId = campRow[0]!.id;

  const baseInput: AudienceSnapshotInput = {
    campaignId,
    orgId: f.org_id,
    segmentIds: [],
    contactGroupIds: [f.group_id],
    // All status categories on ⇒ everyone in the group qualifies (opt-outs still
    // excluded), so the only variable between ON/OFF is the LAYER 3 exclusion.
    filters: {
      include_no_status: true,
      include_opt_in: true,
      include_clickers: true,
      include_not_clicked: true,
    },
    cap: null,
    excludeInUse: false,
    offerId: f.offer_id,
  };

  const onInput = { ...baseInput, excludePriorOffer: true };
  const offInput = { ...baseInput, excludePriorOffer: false };

  const [previewOn, previewOff] = await Promise.all([
    previewAudience(onInput),
    previewAudience(offInput),
  ]);
  // Serialize the snapshots — both insert (campaign_id=0) rows into the same
  // temp/pool index before rolling back, so running them concurrently deadlocks.
  const snapOn = await snapshotTotalRolledBack(onInput);
  const snapOff = await snapshotTotalRolledBack(offInput);

  console.log(
    `  preview: ON=${previewOn.total_matching} OFF=${previewOff.total_matching} (got_offer=${previewOn.got_offer_in_prior_campaign})`,
  );
  console.log(`  snapshot: ON=${snapOn} OFF=${snapOff}`);

  eq(snapOn, previewOn.total_matching, "FIX: frozen snapshot (ON) == previewed will-send (ON)");
  eq(snapOff, previewOff.total_matching, "REGRESSION: snapshot (OFF) == preview (OFF) — OFF path unchanged");
  ok(snapOn < snapOff, `LAYER 3 actually excludes prior-offer leads (${snapOff} → ${snapOn})`);
  // got_offer is only populated when the toggle is ON (is_offer_exposed is
  // computed only then); it equals the number removed from the ON total.
  eq(snapOff - snapOn, previewOn.got_offer_in_prior_campaign, "excluded count == reported got_offer_in_prior_campaign");

  await raw.end({ timeout: 5 });
  console.log(failures === 0 ? "\nAll snapshot prior-offer tests passed ✅" : `\nFAILED: ${failures} ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
