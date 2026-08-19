// Verification for two related audience fixes (2026-08-17):
//
//  (1) MULTI-SEGMENT INTERSECT. Selecting 2+ include-segments used to UNION
//      them, so adding a "filter-shaped" segment (a lone `is_not` rule, which
//      matches nearly the whole org) BLEW UP the audience instead of narrowing
//      it — 44,480 → 507,870 in the reported case. Segments now INTERSECT:
//      adding a segment can only shrink the audience. Both the preview path
//      (previewAudience) and the shared source builder used by the snapshot /
//      draft-stage counts (buildAudienceSourceClause) must agree — if they
//      drift, the preview stops predicting what activation freezes.
//
//  (2) SEGMENT-PAGE COUNTS EXCLUDE OPT-OUTS. The segment page counted its
//      audience without opt-out suppression, so it advertised ~10K contacts a
//      campaign could never draw. previewSegmentAudienceCount now reports the
//      SENDABLE audience plus the engagement counters on one basis
//      (sendable + opt_outs = full audience).
//
// Every expectation is computed from raw SQL IN THIS RUN rather than
// hard-coded, so the test can't silently drift as the data changes. Read-only:
// no writes, no snapshot.
//
// Run: npx tsx scripts/test-segment-intersect-and-optout.ts
import { config } from "dotenv";
import { createRequire } from "node:module";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
const req = createRequire(import.meta.url);
try {
  const p = req.resolve("server-only");
  // @ts-expect-error minimal Module cache entry
  req.cache[p] = { id: p, filename: p, loaded: true, exports: {} };
} catch {
  /* noop */
}

async function main() {
  const { previewAudience, computeStageAudienceCountForDraft } = await import(
    "@/lib/audience-snapshot"
  );
  const { previewSegmentAudienceCount } = await import(
    "@/lib/segment-rules-eval"
  );
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");

  let failures = 0;
  const ok = (c: boolean, m: string) => {
    if (c) console.log(`  ✓ ${m}`);
    else {
      failures++;
      console.error(`  ✗ ${m}`);
    }
  };
  const eq = (actual: unknown, expected: unknown, m: string) =>
    ok(actual === expected, `${m} (got ${actual}, expected ${expected})`);

  // Pick the two segments by name so the test survives id churn. SEG_FILTER is
  // the "filter-shaped" one: a single is_not rule matching nearly the whole org
  // — precisely the shape that made UNION explode.
  const segRows = await db.execute<{ id: number; org_id: string; name: string }>(
    sql`SELECT id, org_id, name FROM segments
        WHERE name IN ('Clickers excl Buyers','Not Used Last 1 Week')
        ORDER BY name`,
  );
  if (segRows.length !== 2) {
    console.error(
      `FATAL: expected both fixture segments, found ${segRows.length}`,
    );
    process.exit(1);
  }
  const segNarrow = segRows.find((r) => r.name === "Clickers excl Buyers")!;
  const segFilter = segRows.find((r) => r.name === "Not Used Last 1 Week")!;
  const orgId = segNarrow.org_id;

  const groupRows = await db.execute<{ id: number }>(
    sql`SELECT id FROM contact_groups ORDER BY id`,
  );
  const groupIds = groupRows.map((r) => r.id);

  const allFilters = {
    include_no_status: true,
    include_opt_in: true,
    include_clickers: true,
    include_not_clicked: true,
  };

  // ---------------------------------------------------------------- part 1
  console.log("\n(1) Segment-page counts exclude opt-outs");

  const [rawSeg] = await db.execute<{
    full: number;
    opted_out: number;
    sendable: number;
  }>(sql`
    with audience as (
      select elig_s.contact_id from (
        select contact_id from (
          select sc.contact_id from segment_contacts sc
            where sc.segment_id = ${segNarrow.id}::int and sc.org_id = ${orgId}::uuid
          union
          ((select contact_id from clickers where org_id = ${orgId}::uuid)
           except
           (select distinct contact_id from stage_sends
              where org_id = ${orgId}::uuid and sale_status in ('lead','sale')))
        ) combined
      ) elig_s
      inner join contacts elig_c on elig_c.id = elig_s.contact_id
        and elig_c.org_id = ${orgId}::uuid and elig_c.messaging_status = 'eligible'
    )
    select count(*)::int as full,
      count(*) filter (where exists (
        select 1 from opt_outs oo
        where oo.contact_id = audience.contact_id and oo.org_id = ${orgId}::uuid))::int as opted_out,
      count(*) filter (where not exists (
        select 1 from opt_outs oo
        where oo.contact_id = audience.contact_id and oo.org_id = ${orgId}::uuid))::int as sendable
    from audience
  `);

  const segCounts = await previewSegmentAudienceCount(segNarrow.id, orgId);
  ok(!segCounts.truncated, "segment audience count did not time out");
  eq(segCounts.total, rawSeg.full, "reported full audience");
  eq(segCounts.opt_out_count, rawSeg.opted_out, "reported opt-outs in audience");
  eq(
    segCounts.count,
    rawSeg.sendable,
    "reported SENDABLE audience (opt-outs excluded)",
  );
  // The reconciliation the segment page now promises its reader.
  eq(
    (segCounts.count ?? 0) + (segCounts.opt_out_count ?? 0),
    segCounts.total,
    "sendable + opt-outs == full audience",
  );
  ok(
    (segCounts.opt_out_count ?? 0) > 0,
    `fixture actually exercises opt-out suppression (${rawSeg.opted_out} opt-outs)`,
  );

  // ---------------------------------------------------------------- part 2
  console.log("\n(2) Multiple segments INTERSECT (preview path)");

  const one = await previewAudience({
    orgId,
    segmentIds: [segNarrow.id],
    contactGroupIds: groupIds,
    filters: allFilters,
  });
  const two = await previewAudience({
    orgId,
    segmentIds: [segNarrow.id, segFilter.id],
    contactGroupIds: groupIds,
    filters: allFilters,
  });
  // Order must not matter for an INTERSECT.
  const twoSwapped = await previewAudience({
    orgId,
    segmentIds: [segFilter.id, segNarrow.id],
    contactGroupIds: groupIds,
    filters: allFilters,
  });

  eq(one.total_matching, rawSeg.sendable, "single segment matches raw SQL");

  const [rawBoth] = await db.execute<{ intersect_n: number; union_n: number }>(sql`
    with grp as (
      select distinct ccg.contact_id
      from contact_contact_groups ccg
      inner join contacts c on c.id = ccg.contact_id
        and c.org_id = ${orgId}::uuid and c.messaging_status = 'eligible'
      where ccg.org_id = ${orgId}::uuid
    ),
    a as (
      select elig_s.contact_id from (
        select contact_id from (
          select sc.contact_id from segment_contacts sc
            where sc.segment_id = ${segNarrow.id}::int and sc.org_id = ${orgId}::uuid
          union
          ((select contact_id from clickers where org_id = ${orgId}::uuid)
           except
           (select distinct contact_id from stage_sends
              where org_id = ${orgId}::uuid and sale_status in ('lead','sale')))
        ) combined
      ) elig_s
      inner join contacts elig_c on elig_c.id = elig_s.contact_id
        and elig_c.org_id = ${orgId}::uuid and elig_c.messaging_status = 'eligible'
      where not exists (select 1 from opt_outs oo
        where oo.contact_id = elig_s.contact_id and oo.org_id = ${orgId}::uuid)
    ),
    b as (
      select elig_s.contact_id from (
        select contact_id from (
          select sc.contact_id from segment_contacts sc
            where sc.segment_id = ${segFilter.id}::int and sc.org_id = ${orgId}::uuid
          union
          ((select contact_id from grp)
           except
           (select distinct p.contact_id from campaign_audience_pool p
              join campaigns ca on ca.id = p.campaign_id
             where p.org_id = ${orgId}::uuid and ca.org_id = ${orgId}::uuid
               and ca.status in ('active','paused','completed')
               and ca.created_at >= now() - interval '7 days'
               and exists (select 1 from campaign_stages s
                 where s.campaign_id = ca.id and s.org_id = ${orgId}::uuid
                   and s.status in ('draft','pending','sent','success'))))
        ) combined
      ) elig_s
      inner join contacts elig_c on elig_c.id = elig_s.contact_id
        and elig_c.org_id = ${orgId}::uuid and elig_c.messaging_status = 'eligible'
      where not exists (select 1 from opt_outs oo
        where oo.contact_id = elig_s.contact_id and oo.org_id = ${orgId}::uuid)
    )
    select
      (select count(*) from (select contact_id from a intersect select contact_id from b) i)::int as intersect_n,
      (select count(*) from (select contact_id from a union select contact_id from b) u)::int as union_n
  `);

  eq(two.total_matching, rawBoth.intersect_n, "two segments == set INTERSECT");
  eq(
    twoSwapped.total_matching,
    rawBoth.intersect_n,
    "segment order does not change the audience",
  );
  ok(
    two.total_matching !== rawBoth.union_n,
    `two segments is NOT the old UNION (union would have been ${rawBoth.union_n})`,
  );
  // The invariant the user asked for, stated directly.
  ok(
    two.total_matching <= one.total_matching,
    `adding a segment only narrows: ${one.total_matching} -> ${two.total_matching}`,
  );
  eq(
    two.from_segments,
    rawBoth.intersect_n,
    "'From segments' reports the intersected segment side",
  );

  // ---------------------------------------------------------------- part 3
  // The snapshot / draft-stage path builds its source through
  // buildAudienceSourceClause, a DIFFERENT code path from previewAudience's
  // membership flags. Both must land on the same audience or activation
  // freezes something the preview never showed.
  console.log("\n(3) Shared source builder (snapshot / draft-stage path)");

  const draftFilters = {
    include_no_status: true,
    include_clickers: true,
    exclude_clickers: false,
  };
  const draftOne = await computeStageAudienceCountForDraft(
    {
      id: 0,
      orgId,
      segmentIds: [segNarrow.id],
      contactGroupIds: groupIds,
      filters: allFilters,
      cap: null,
    },
    draftFilters,
  );
  const draftTwo = await computeStageAudienceCountForDraft(
    {
      id: 0,
      orgId,
      segmentIds: [segNarrow.id, segFilter.id],
      contactGroupIds: groupIds,
      filters: allFilters,
      cap: null,
    },
    draftFilters,
  );

  // Expected = the same INTERSECT, restricted by the stage's status filters:
  // no-status (no opt-in, no click) OR clicker.
  const [rawDraft] = await db.execute<{ n: number }>(sql`
    with grp as (
      select distinct ccg.contact_id
      from contact_contact_groups ccg
      inner join contacts c on c.id = ccg.contact_id
        and c.org_id = ${orgId}::uuid and c.messaging_status = 'eligible'
      where ccg.org_id = ${orgId}::uuid
    ),
    a as (
      select elig_s.contact_id from (
        select contact_id from (
          select sc.contact_id from segment_contacts sc
            where sc.segment_id = ${segNarrow.id}::int and sc.org_id = ${orgId}::uuid
          union
          ((select contact_id from clickers where org_id = ${orgId}::uuid)
           except
           (select distinct contact_id from stage_sends
              where org_id = ${orgId}::uuid and sale_status in ('lead','sale')))
        ) combined
      ) elig_s
      inner join contacts elig_c on elig_c.id = elig_s.contact_id
        and elig_c.org_id = ${orgId}::uuid and elig_c.messaging_status = 'eligible'
    ),
    b as (
      select elig_s.contact_id from (
        select contact_id from (
          select sc.contact_id from segment_contacts sc
            where sc.segment_id = ${segFilter.id}::int and sc.org_id = ${orgId}::uuid
          union
          ((select contact_id from grp)
           except
           (select distinct p.contact_id from campaign_audience_pool p
              join campaigns ca on ca.id = p.campaign_id
             where p.org_id = ${orgId}::uuid and ca.org_id = ${orgId}::uuid
               and ca.status in ('active','paused','completed')
               and ca.created_at >= now() - interval '7 days'
               and exists (select 1 from campaign_stages s
                 where s.campaign_id = ca.id and s.org_id = ${orgId}::uuid
                   and s.status in ('draft','pending','sent','success'))))
        ) combined
      ) elig_s
      inner join contacts elig_c on elig_c.id = elig_s.contact_id
        and elig_c.org_id = ${orgId}::uuid and elig_c.messaging_status = 'eligible'
    ),
    src as (
      select contact_id from (
        select contact_id from a intersect select contact_id from b
      ) ab
      intersect
      select contact_id from grp
    )
    select count(*)::int as n
    from src
    where not exists (select 1 from opt_outs oo
        where oo.contact_id = src.contact_id and oo.org_id = ${orgId}::uuid)
      and (
        (not exists (select 1 from opt_ins oi
            where oi.contact_id = src.contact_id and oi.org_id = ${orgId}::uuid)
         and not exists (select 1 from clickers cl
            where cl.contact_id = src.contact_id and cl.org_id = ${orgId}::uuid))
        or exists (select 1 from clickers cl
            where cl.contact_id = src.contact_id and cl.org_id = ${orgId}::uuid)
      )
  `);

  eq(
    draftTwo.count,
    rawDraft.n,
    "draft stage count uses the INTERSECT'd source",
  );
  ok(
    draftTwo.count <= draftOne.count,
    `draft stage count only narrows: ${draftOne.count} -> ${draftTwo.count}`,
  );

  console.log(
    failures === 0
      ? "\nALL PASS"
      : `\n${failures} FAILURE(S)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
