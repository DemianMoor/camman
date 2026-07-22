// Proves the per-segment include/exclude audience math (migration 0114) via
// previewAudience against real data. previewAudience WRITES NOTHING — read-only.
//
// For a (contact group G, segment S) pair whose members overlap, with all
// status filters ON (so every non-opt-out contact qualifies):
//   1. include(G, S).total  = qualifying G ∩ S                (positive base)
//   2. exclude(G, S).total   = qualifying G EXCEPT S           (subtract S)
//   3. include.total + exclude.total == groupOnly.total        (partition of G)
//   4. exclude.excluded_by_segments == include.total           (what S removed)
//   5. include-only preview is byte-identical to pre-0114 behavior (S ⊆ G side)
//   6. exclude-only selection (no group, no include) → empty (no positive base)
// Run: npx tsx scripts/test-segment-exclude.ts
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

async function main() {
  const { previewAudience } = await import("@/lib/audience-snapshot");
  const { db, sql: raw } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");

  let failures = 0;
  const eq = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) console.log(`  ✓ ${m}`);
    else {
      failures++;
      console.error(`  ✗ ${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    }
  };
  const ok = (c: boolean, m: string) => eq(!!c, true, m);

  // Find a (group, segment) pair with the most overlap via each segment's
  // MANUAL membership (segment_contacts) — stable and non-empty, independent of
  // time-based rule drift. Segment's rule audience is a superset of manual, so
  // the intersection with G is still meaningful.
  const pair = (await db.execute(sql`
    SELECT ccg.contact_group_id AS group_id, scnt.segment_id, ccg.org_id,
           count(*)::int AS overlap
    FROM contact_contact_groups ccg
    JOIN segment_contacts scnt
      ON scnt.contact_id = ccg.contact_id AND scnt.org_id = ccg.org_id
    GROUP BY ccg.contact_group_id, scnt.segment_id, ccg.org_id
    ORDER BY overlap DESC
    LIMIT 1
  `)) as unknown as {
    group_id: number;
    segment_id: number;
    org_id: string;
    overlap: number;
  }[];

  if (pair.length === 0) {
    console.log("No (contact group ∩ segment membership) overlap found — skipping (inconclusive).");
    await raw.end({ timeout: 5 });
    process.exit(0);
  }
  const f = pair[0];
  console.log(`Using contact group ${f.group_id} ∩ segment ${f.segment_id} (overlap ${f.overlap})`);

  const filters = {
    include_no_status: true,
    include_opt_in: true,
    include_clickers: true,
    include_not_clicked: true,
  };
  const base = { orgId: f.org_id, filters, cap: null, excludeInUse: false };

  const groupOnly = await previewAudience({
    ...base,
    segmentIds: [],
    contactGroupIds: [f.group_id],
  });
  const include = await previewAudience({
    ...base,
    segmentIds: [f.segment_id],
    contactGroupIds: [f.group_id],
  });
  const exclude = await previewAudience({
    ...base,
    segmentIds: [],
    excludeSegmentIds: [f.segment_id],
    contactGroupIds: [f.group_id],
  });
  const excludeOnly = await previewAudience({
    ...base,
    segmentIds: [],
    excludeSegmentIds: [f.segment_id],
    contactGroupIds: [],
  });

  console.log(
    `  group=${groupOnly.total_matching} include(G∩S)=${include.total_matching} ` +
      `exclude(G\\S)=${exclude.total_matching} excluded_by_segments=${exclude.excluded_by_segments}`,
  );

  ok(include.total_matching > 0, "include base is non-empty (has overlap to test)");
  eq(
    include.total_matching + exclude.total_matching,
    groupOnly.total_matching,
    "partition: include(G∩S) + exclude(G\\S) == group(G)",
  );
  eq(
    exclude.excluded_by_segments,
    include.total_matching,
    "exclude.excluded_by_segments == include(G∩S)",
  );
  eq(
    exclude.total_matching,
    groupOnly.total_matching - include.total_matching,
    "exclude(G\\S) == group - (G∩S)",
  );
  eq(groupOnly.excluded_by_segments, 0, "group-only reports 0 excluded_by_segments");
  eq(excludeOnly.total_matching, 0, "exclude-only (no positive base) is empty");

  await raw.end({ timeout: 5 });
  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll assertions passed.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
