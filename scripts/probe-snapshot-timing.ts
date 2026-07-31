// Times snapshotAudience for the recipes of recent campaigns, ALWAYS rolled
// back (no pool rows written). Diagnoses the "create campaign → Vercel 60s
// timeout" report by finding which recipe blows past the limit.
// Run: npx tsx scripts/probe-snapshot-timing.ts
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

const ORG = "b0ce3435-5ea2-4510-ab11-8cdd0d0c125b";
// Bound each attempt so a pathological plan can't pin a prod connection.
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 90_000);
const ONLY = process.env.PROBE_ONLY ? process.env.PROBE_ONLY.split(",").map(Number) : null;

class Rollback extends Error {}

async function main() {
  const { snapshotAudience } = await import("@/lib/audience-snapshot");
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");

  const recipes = (await db.execute(sql`
    select id, name, status, created_at,
      audience_segment_ids, audience_exclude_segment_ids, audience_contact_group_ids,
      audience_filters, audience_cap, exclude_in_use_contacts,
      exclude_prior_offer_contacts, offer_id, audience_snapshot_count
    from campaigns
    where org_id = ${ORG}::uuid and created_at > now() - interval '36 hours'
    order by created_at desc
  `)) as unknown as {
    id: number;
    name: string;
    status: string;
    audience_segment_ids: number[] | null;
    audience_exclude_segment_ids: number[] | null;
    audience_contact_group_ids: number[] | null;
    audience_filters: Record<string, unknown>;
    audience_cap: number | null;
    exclude_in_use_contacts: boolean;
    exclude_prior_offer_contacts: boolean;
    offer_id: number | null;
    audience_snapshot_count: number;
  }[];

  for (const r of recipes) {
    if (ONLY && !ONLY.includes(r.id)) continue;
    const label = `#${r.id} segs=${JSON.stringify(r.audience_segment_ids)} groups=${JSON.stringify(
      r.audience_contact_group_ids,
    )} cap=${r.audience_cap} inUse=${r.exclude_in_use_contacts} priorOffer=${r.exclude_prior_offer_contacts} carrier=${
      (r.audience_filters as { carrier_filter?: string[] })?.carrier_filter?.length ?? 0
    }`;
    const t0 = Date.now();
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local statement_timeout = ${TIMEOUT_MS}`));
        const snap = await snapshotAudience(
          {
            campaignId: r.id,
            orgId: ORG,
            segmentIds: r.audience_segment_ids ?? [],
            excludeSegmentIds: r.audience_exclude_segment_ids ?? [],
            contactGroupIds: r.audience_contact_group_ids ?? [],
            filters: r.audience_filters as never,
            cap: r.audience_cap,
            excludeInUse: r.exclude_in_use_contacts,
            excludePriorOffer: r.exclude_prior_offer_contacts,
            offerId: r.offer_id,
          },
          tx,
        );
        console.log(
          `${((Date.now() - t0) / 1000).toFixed(1)}s  OK   ${label} -> count=${snap.count} total=${snap.total_matching} (orig ${r.audience_snapshot_count})`,
        );
        throw new Rollback();
      });
    } catch (e) {
      if (e instanceof Rollback) continue;
      console.log(
        `${((Date.now() - t0) / 1000).toFixed(1)}s  FAIL ${label} -> ${(e as Error).message?.slice(0, 160)}`,
      );
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
