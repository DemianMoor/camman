import "./_env-preload";

// READ-ONLY merge-gate numbers for PR 4b, against production.
//
// ⭐ NOTHING HERE WRITES, AND NO CAMPAIGN IS CREATED OR FLIPPED (owner
// decision, 2026-09-25). The lifecycle behaviour is a PARAMETER on every one of
// these paths — `lifecycleRules` on AudiencePreviewInput and on
// StageEligibilityParams — which is exactly why PR 4b makes it a required
// field. So the hypothetical "what would this campaign's audience be if it
// were a lifecycle campaign" can be evaluated by passing true, against a real
// campaign's own stored inputs, without touching a single row.
//
// It answers the two questions the merge gate asks:
//   1. what does each chip select, against what the campaign's CURRENT filters
//      select — i.e. what changes if this campaign is switched over;
//   2. what would the three send-time layers exclude on a real stage, per layer.
//
// Run it off the busy cron minutes (:29/:59 pools, :11/:41 fresh counts, :14
// creative lifetime, the */5 marks, and :10/:25/:40/:55 for the engagement job).
//
// Listed in EXCLUSIONS of scripts/test-preview-db-guard.ts: it reads production
// deliberately, via libraries, and carries no write token of its own.
//
// Run: npx tsx --conditions=react-server scripts/measure-lifecycle-audience.ts
//      [--campaign <id>]

import { sql } from "drizzle-orm";

const argCampaign = (() => {
  const i = process.argv.indexOf("--campaign");
  return i >= 0 ? Number(process.argv[i + 1]) : null;
})();

const n = (v: number) => v.toLocaleString();
const ms = (t: number) => `${Math.round(t)} ms`;

async function main() {
  const { db } = await import("@/db/client");
  const { previewAudience } = await import("@/lib/audience-snapshot");
  const { buildStageEligibilityExclusions } =
    await import("@/lib/sends/eligibility");
  const { LIFECYCLE_CHIP_STATUSES } =
    await import("@/lib/validators/campaigns");

  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x")
    .hostname;
  console.log(`measuring against ${host} — READ ONLY, no writes\n`);

  type Row = {
    id: number;
    org_id: string;
    name: string | null;
    status: string;
    lifecycle_rules: boolean;
    offer_id: number | null;
    audience_segment_ids: number[] | null;
    audience_exclude_segment_ids: number[] | null;
    audience_contact_group_ids: number[] | null;
    audience_filters: Record<string, unknown> | null;
    exclude_in_use_contacts: boolean;
    exclude_prior_offer_contacts: boolean;
    snapshot_count: number | null;
  };

  // A representative campaign: a real, recent one with a real audience recipe.
  // Explicitly NOT created for this measurement.
  const rows = (await db.execute(sql`
    SELECT c.id, c.org_id, c.name, c.status, c.lifecycle_rules, c.offer_id,
           c.audience_segment_ids, c.audience_exclude_segment_ids,
           c.audience_contact_group_ids, c.audience_filters,
           c.exclude_in_use_contacts, c.exclude_prior_offer_contacts,
           c.audience_snapshot_count AS snapshot_count
    FROM campaigns c
    WHERE ${
      argCampaign != null
        ? sql`c.id = ${argCampaign}::int`
        : sql`
            coalesce(array_length(c.audience_segment_ids, 1), 0) > 0
            AND c.offer_id IS NOT NULL
            AND c.audience_snapshot_count > 0`
    }
    ORDER BY c.created_at DESC
    LIMIT 1
  `)) as unknown as Row[];
  const c = rows[0];
  if (!c) throw new Error("no campaign matched — pass --campaign <id>");

  console.log(
    `campaign ${c.id} "${c.name ?? "(unnamed)"}" — status ${c.status}, ` +
      `lifecycle_rules ${c.lifecycle_rules}, offer ${c.offer_id ?? "none"}, ` +
      `frozen pool ${n(Number(c.snapshot_count ?? 0))}`,
  );
  console.log(
    `  recipe: ${c.audience_segment_ids?.length ?? 0} segment(s), ` +
      `${c.audience_exclude_segment_ids?.length ?? 0} excl, ` +
      `${c.audience_contact_group_ids?.length ?? 0} group(s), ` +
      `exclude_in_use ${c.exclude_in_use_contacts}\n`,
  );

  const baseInput = {
    orgId: c.org_id,
    segmentIds: c.audience_segment_ids ?? [],
    excludeSegmentIds: c.audience_exclude_segment_ids ?? [],
    contactGroupIds: c.audience_contact_group_ids ?? [],
    excludeInUse: c.exclude_in_use_contacts,
    excludePriorOffer: c.exclude_prior_offer_contacts,
    offerId: c.offer_id,
  };

  // ── 1. what the campaign selects TODAY, with its own stored filters ──────
  console.log("1. TODAY — the campaign's current (legacy) filters");
  let t = performance.now();
  const legacy = await previewAudience({
    // Legacy behaviour is what this bar asserts; the lifecycle predicate
    // has its own suites. Explicit, because the field is required now.
    lifecycleRules: false,
    ...baseInput,
    filters: (c.audience_filters ?? {}) as never,
  });
  console.log(
    `   total_matching ${n(legacy.total_matching)}   (${ms(performance.now() - t)})`,
  );
  console.log(
    `   filters: ${JSON.stringify(c.audience_filters ?? {})}` +
      `\n   opt-out ${n(legacy.excluded_for_optout)}, in use elsewhere ${n(legacy.in_use_in_other_campaigns)}\n`,
  );

  // ── 2. each chip, against the SAME recipe, with lifecycleRules passed ────
  console.log(
    "2. IF SWITCHED OVER — each chip, same segments/groups, lifecycleRules: true",
  );
  const perChip: Record<string, number> = {};
  for (const chip of LIFECYCLE_CHIP_STATUSES) {
    t = performance.now();
    const r = await previewAudience({
      ...baseInput,
      lifecycleRules: true,
      filters: { lifecycle_statuses: [chip] } as never,
    });
    perChip[chip] = r.total_matching;
    console.log(
      `   ${chip.padEnd(7)} ${n(r.total_matching).padStart(9)}   (${ms(performance.now() - t)})`,
    );
  }
  const chipSum = Object.values(perChip).reduce((a, b) => a + b, 0);

  // Every chip at once — must equal the sum, since a contact has ONE status.
  t = performance.now();
  const all = await previewAudience({
    ...baseInput,
    lifecycleRules: true,
    filters: { lifecycle_statuses: [...LIFECYCLE_CHIP_STATUSES] } as never,
  });
  console.log(
    `   ${"ALL".padEnd(7)} ${n(all.total_matching).padStart(9)}   (${ms(performance.now() - t)})` +
      `  — sum of chips ${n(chipSum)}${all.total_matching === chipSum ? " ✓ agree" : " ✗ DISAGREE"}`,
  );
  console.log(
    `   vs today's legacy filters: ${n(legacy.total_matching)} → ${n(all.total_matching)}` +
      ` (${all.total_matching - legacy.total_matching >= 0 ? "+" : ""}${n(all.total_matching - legacy.total_matching)})\n`,
  );

  if (all.lifecycle) {
    const ex = all.lifecycle.excluded;
    console.log("   exclusion buckets (exclusive, priority order):");
    console.log(
      `     opted out ${n(ex.opted_out)} · suppressed ${n(ex.suppressed)} · ` +
        `status not selected ${n(ex.status_not_selected)} · in use elsewhere ${n(ex.in_use_elsewhere)}`,
    );
    console.log(
      `   send-time overlays (inside the audience, skipped on the day):` +
        `\n     freeze not due ${n(all.lifecycle.send_time.freeze_not_due)} · ` +
        `bought this offer ${n(all.lifecycle.send_time.bought_offer)}\n`,
    );
  }

  // ── 3. the three layers on a real stage, per layer ───────────────────────
  console.log("3. THE THREE SEND-TIME LAYERS — counted over this org");
  const stage = (await db.execute(sql`
    SELECT s.id, s.creative_id
    FROM campaign_stages s
    WHERE s.campaign_id = ${c.id}::int
    ORDER BY s.stage_number
    LIMIT 1
  `)) as unknown as { id: number; creative_id: number | null }[];
  const layers = buildStageEligibilityExclusions({
    orgId: c.org_id,
    currentCampaignId: c.id,
    currentCreativeId: stage[0]?.creative_id ?? null,
    currentOfferId: c.offer_id,
    excludePriorOffer: c.exclude_prior_offer_contacts,
    // ⭐ The hypothetical, as an argument. The campaign row is untouched.
    lifecycleRules: true,
  });
  for (const l of layers) {
    t = performance.now();
    const r = (await db.execute(
      sql`SELECT count(*)::int AS n FROM (${l.sql}) x`,
    )) as unknown as { n: number }[];
    console.log(
      `   ${l.key.padEnd(15)} ${n(Number(r[0]?.n ?? 0)).padStart(9)}   (${ms(performance.now() - t)})`,
    );
  }

  console.log(
    `\n   stage ${stage[0]?.id ?? "(none)"}, creative ${stage[0]?.creative_id ?? "none"}`,
  );
  console.log("\nDone. No rows were written.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
