// Hotfix 2026-10-22: GET /api/campaigns/<draft>/stages returned 500 for every
// draft campaign since 69cac487 (2026-07-03) — the shared split filter hashes
// `contact_id`, which the draft batch's `qualified` CTE never selected.
// Bar: the batched draft count runs, and equals the per-stage draft count for a
// plain stage and both halves of a split. Committed fixture on the preview DB,
// torn down by id.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-draft-stage-counts-batch.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { computeStageAudienceCountForDraft, computeStageAudienceCountsBatchForDraft } from "@/lib/audience-snapshot";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const one = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as T[])[0];

async function main() {
  const sfx = Date.now().toString().slice(-8);
  const made = { campaign: 0, segment: 0, contacts: [] as string[] };
  try {
    const orgId = (await one<{ id: string }>(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)).id;
    const seg = await one<{ id: number }>(sql`INSERT INTO segments (org_id, segment_id, name) VALUES (${orgId}, ${"dsc-" + sfx}, 'dsc') RETURNING id`);
    made.segment = seg.id;
    for (let i = 0; i < 9; i++) {
      const c = await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number, messaging_status) VALUES (${orgId}, ${`+1910${sfx.slice(-6)}${i}`}, 'eligible') RETURNING id`);
      made.contacts.push(c.id);
      await db.execute(sql`INSERT INTO segment_contacts (segment_id, contact_id, org_id) VALUES (${seg.id}, ${c.id}, ${orgId})`);
    }
    const camp = await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, link_mode, audience_segment_ids, audience_filters, exclude_in_use_contacts)
      VALUES (${orgId}, ${"dsc-" + sfx}, 'dsc', 'draft', 'manual', ARRAY[${seg.id}]::int[], ${JSON.stringify({ include_no_status: true })}::jsonb, false) RETURNING id`);
    made.campaign = camp.id;
    const campaign = {
      carrierRejectedSuppression: false, // legacy test: predates carrier-rejection suppression (toggle off)
      id: camp.id, orgId, segmentIds: [seg.id], excludeSegmentIds: [], contactGroupIds: [],
      filters: { include_no_status: true }, cap: null, excludeInUse: false, lifecycleRules: false,
      offerId: null,
    };
    const shapes = [
      { stageId: 1, include_no_status: true, include_clickers: false, exclude_clickers: false, split_index: null, split_total: null },
      { stageId: 2, include_no_status: true, include_clickers: false, exclude_clickers: false, split_index: 1, split_total: 2 },
      { stageId: 3, include_no_status: true, include_clickers: false, exclude_clickers: false, split_index: 2, split_total: 2 },
    ];
    let batch: Map<number, number> | null = null;
    try {
      batch = await computeStageAudienceCountsBatchForDraft(campaign, shapes);
    } catch (e) {
      bar("D1 the batched draft count runs (the stages list no longer 500s)", false, String((e as Error).cause ?? e).slice(0, 160));
    }
    if (batch) {
      bar("D1 the batched draft count runs (the stages list no longer 500s)", true);
      const single = await Promise.all(shapes.map((s) =>
        computeStageAudienceCountForDraft({ ...campaign, offerId: null }, {
          include_no_status: s.include_no_status, include_clickers: s.include_clickers, exclude_clickers: s.exclude_clickers,
          split_index: s.split_index, split_total: s.split_total,
        })));
      const got = shapes.map((s) => batch!.get(s.stageId) ?? 0);
      const want = single.map((r) => r.count);
      bar("D2 batched == per-stage for a plain stage and both split halves", JSON.stringify(got) === JSON.stringify(want), `batch ${JSON.stringify(got)} vs single ${JSON.stringify(want)}`);
      bar("D3 plain stage counts all 9; the halves add up to 9", got[0] === 9 && got[1] + got[2] === 9, JSON.stringify(got));
    }

    // ── D4–D6: a LIFECYCLE campaign (2026-11-06) ────────────────────────────
    // The batch used to skip the lifecycle exclusion layers the single-stage
    // count applies, so the two disagreed for every lifecycle campaign. Fixture:
    // the 9 'new' contacts above + 4 'freeze' contacts messaged yesterday on a
    // 14-day cadence (the freeze_not_due layer). Chips {new, freeze}: the chip
    // predicate admits all 13, and only the layer removes the 4.
    for (let i = 0; i < 4; i++) {
      const c = await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number, messaging_status, lifecycle_status)
        VALUES (${orgId}, ${`+1911${sfx.slice(-6)}${i}`}, 'eligible', 'freeze') RETURNING id`);
      made.contacts.push(c.id);
      await db.execute(sql`INSERT INTO segment_contacts (segment_id, contact_id, org_id) VALUES (${seg.id}, ${c.id}, ${orgId})`);
      await db.execute(sql`
        INSERT INTO contact_engagement (contact_id, org_id, status, status_changed_at, last_sent_at,
                                        freeze_cadence_days, thresholds, computed_at)
        VALUES (${c.id}, ${orgId}, 'freeze', now(), now() - interval '1 day', 14, '{}'::jsonb, now())`);
    }
    const lifecycle = {
      ...campaign,
      lifecycleRules: true,
      filters: { include_no_status: true, lifecycle_statuses: ["new", "freeze"] },
    };
    const lcBatch = await computeStageAudienceCountsBatchForDraft(lifecycle, shapes);
    const lcSingle = await Promise.all(shapes.map((s) =>
      computeStageAudienceCountForDraft(lifecycle, {
        include_no_status: s.include_no_status, include_clickers: s.include_clickers, exclude_clickers: s.exclude_clickers,
        split_index: s.split_index, split_total: s.split_total,
      })));
    const lcGot = shapes.map((s) => lcBatch.get(s.stageId) ?? 0);
    const lcWant = lcSingle.map((r) => r.count);
    bar("D4 lifecycle campaign: batched == per-stage (plain + both halves)", JSON.stringify(lcGot) === JSON.stringify(lcWant), `batch ${JSON.stringify(lcGot)} vs single ${JSON.stringify(lcWant)}`);
    bar("D5 lifecycle campaign: the 4 freeze-not-due contacts are excluded (9, not 13)", lcGot[0] === 9, `plain stage ${lcGot[0]}`);
    const capped = await computeStageAudienceCountsBatchForDraft({ ...lifecycle, cap: 5 }, shapes);
    bar("D6 lifecycle campaign with cap 5: every stage clamps to min(5, count)", shapes.every((s) => (capped.get(s.stageId) ?? 0) === Math.min(5, lcGot[shapes.indexOf(s)])), JSON.stringify([...capped.values()]));
  } finally {
    if (made.campaign) await db.execute(sql`DELETE FROM campaigns WHERE id = ${made.campaign}`);
    for (const id of made.contacts) await db.execute(sql`DELETE FROM contacts WHERE id = ${id}`);
    if (made.segment) await db.execute(sql`DELETE FROM segments WHERE id = ${made.segment}`);
    await pgConn.end({ timeout: 5 });
  }
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
