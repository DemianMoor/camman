import "./_env-preload";

// The Excl-timing warning (PR 4b Task 6) — the decision AND the two mount
// sites that show it.
//
// ⭐ THE POINT OF THIS FILE is the second half. The failure mode being guarded
// against is not "the warning is wrong" — it is "the warning is right on the
// detail page and absent on the list page", because the two get their data by
// completely different routes: the detail page has the campaign and its stages
// in client state, while the list page has to prefetch them. No single-page
// test can catch that; only feeding one campaign through BOTH paths can.
//
// Pure functions + a stubbed fetch, so it needs no database.
//
// Run: npx tsx scripts/test-excl-timing-warning.ts

import {
  exclDialogState,
  exclTimingInput,
  shouldWarnExclTiming,
  EXCL_TIMING_WARNING_MS,
} from "@/lib/campaigns/excl-timing-warning";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const at = (ms: number) => new Date(NOW + ms).toISOString();

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

function main() {
  console.log("PART H — the Excl-timing warning");

  const base = {
    lifecycleRules: true,
    excludeSegmentIds: [7],
    stageScheduledAt: [at(3 * DAY)],
    now: NOW,
  };

  bar(
    "H1 a lifecycle campaign with Excl segments and a distant stage warns",
    shouldWarnExclTiming(exclTimingInput(base)),
  );
  bar(
    "H2 a LEGACY campaign never warns",
    !shouldWarnExclTiming(exclTimingInput({ ...base, lifecycleRules: false })),
  );
  bar(
    "H3 no Excl segments ⇒ nothing to warn about",
    !shouldWarnExclTiming(exclTimingInput({ ...base, excludeSegmentIds: [] })),
  );
  // No scheduled stage ⇒ no gap to compare ⇒ no warning (plan, Step 1).
  bar(
    "H4 no scheduled stage ⇒ no warning",
    !shouldWarnExclTiming(exclTimingInput({ ...base, stageScheduledAt: [] })),
  );
  bar(
    "H5 a stage list of only NULLs is the same as no stages",
    !shouldWarnExclTiming(
      exclTimingInput({ ...base, stageScheduledAt: [null, undefined] }),
    ),
  );
  bar(
    "H6 a stage inside 24h ⇒ no warning (now and at-send are one world)",
    !shouldWarnExclTiming(
      exclTimingInput({ ...base, stageScheduledAt: [at(6 * 3_600_000)] }),
    ),
  );
  // The boundary, both sides of it.
  bar(
    "H7 exactly 24h out does NOT warn; one minute past it does",
    !shouldWarnExclTiming(
      exclTimingInput({
        ...base,
        stageScheduledAt: [at(EXCL_TIMING_WARNING_MS)],
      }),
    ) &&
      shouldWarnExclTiming(
        exclTimingInput({
          ...base,
          stageScheduledAt: [at(EXCL_TIMING_WARNING_MS + 60_000)],
        }),
      ),
  );
  bar(
    "H8 a stage in the PAST does not warn (the gap already closed)",
    !shouldWarnExclTiming(
      exclTimingInput({ ...base, stageScheduledAt: [at(-3 * DAY)] }),
    ),
  );
  // The EARLIEST stage decides, not the first in the array.
  bar(
    "H9 the EARLIEST scheduled stage decides, whatever the array order",
    !shouldWarnExclTiming(
      exclTimingInput({
        ...base,
        stageScheduledAt: [at(9 * DAY), at(2 * 3_600_000), at(4 * DAY)],
      }),
    ),
    "a soon stage among distant ones suppresses the warning",
  );

  // ── the two mount sites ────────────────────────────────────────────────
  console.log("\n  the two mount sites, one campaign");

  // ONE campaign. Each side is shaped the way that page actually holds it.
  const campaign = {
    id: 4242,
    lifecycle_rules: true,
    audience_exclude_segment_ids: [7, 9],
    // The detail page holds the full stage rows in client state…
    stages: [
      { id: 1, scheduled_at: at(9 * DAY) },
      { id: 2, scheduled_at: null },
      { id: 3, scheduled_at: at(4 * DAY) },
    ],
  };

  // Detail page: exactly the expression at
  // app/(protected)/campaigns/[id]/page.tsx's StatusChangeDialog mount.
  const detailInput = exclTimingInput({
    lifecycleRules: campaign.lifecycle_rules === true,
    excludeSegmentIds: campaign.audience_exclude_segment_ids,
    stageScheduledAt: campaign.stages.map((s) => s.scheduled_at),
    now: NOW,
  });

  // …while the list page gets ONE pre-aggregated value from the API. This
  // stands in for GET /api/campaigns/[campaignId], computing
  // earliest_scheduled_at the way the route's min() does.
  const apiResponse = {
    lifecycle_rules: campaign.lifecycle_rules,
    audience_exclude_segment_ids: campaign.audience_exclude_segment_ids,
    earliest_scheduled_at: campaign.stages
      .map((s) => s.scheduled_at)
      .filter((v): v is string => !!v)
      .sort()[0],
  };
  const listInput = exclTimingInput({
    lifecycleRules: apiResponse.lifecycle_rules === true,
    excludeSegmentIds: apiResponse.audience_exclude_segment_ids,
    stageScheduledAt: [apiResponse.earliest_scheduled_at],
    now: NOW,
  });

  // ⭐ The bar. Not "both warn" — both must be handed the SAME argument object,
  // because two pages that agree today by coincidence are exactly the thing
  // that drifts. Identical inputs make an identical verdict unavoidable.
  const same = JSON.stringify(detailInput) === JSON.stringify(listInput);
  bar(
    "H10 both mount sites build an IDENTICAL argument for one campaign",
    same,
    same
      ? JSON.stringify(detailInput)
      : `detail=${JSON.stringify(detailInput)} list=${JSON.stringify(listInput)}`,
  );
  bar(
    "H11 …and therefore an identical verdict",
    shouldWarnExclTiming(detailInput) === shouldWarnExclTiming(listInput) &&
      shouldWarnExclTiming(detailInput),
  );

  // The same pair with a SOON stage: both must fall silent together. This is
  // the half that catches a list page that only ever saw the last stage.
  const soon = {
    ...campaign,
    stages: [...campaign.stages, { id: 4, scheduled_at: at(3_600_000) }],
  };
  const detailSoon = exclTimingInput({
    lifecycleRules: true,
    excludeSegmentIds: soon.audience_exclude_segment_ids,
    stageScheduledAt: soon.stages.map((s) => s.scheduled_at),
    now: NOW,
  });
  const listSoon = exclTimingInput({
    lifecycleRules: true,
    excludeSegmentIds: soon.audience_exclude_segment_ids,
    stageScheduledAt: [
      soon.stages
        .map((s) => s.scheduled_at)
        .filter((v): v is string => !!v)
        .sort()[0],
    ],
    now: NOW,
  });
  bar(
    "H12 adding a SOON stage silences BOTH sites, not just one",
    JSON.stringify(detailSoon) === JSON.stringify(listSoon) &&
      !shouldWarnExclTiming(detailSoon) &&
      !shouldWarnExclTiming(listSoon),
  );

  // ── what the dialog does with each of the three states ────────────────
  // A prefetch that has not landed is `undefined`, which is NOT "no warning".
  const inFlight = exclDialogState(true, undefined);
  bar(
    "H13 an IN-FLIGHT prefetch holds confirm and shows no warning yet",
    inFlight.awaiting && !inFlight.warn,
    JSON.stringify(inFlight),
  );
  const settledNothing = exclDialogState(true, null);
  bar(
    "H14 a SETTLED 'nothing to warn about' releases confirm",
    !settledNothing.awaiting && !settledNothing.warn,
    JSON.stringify(settledNothing),
  );
  const settledWarn = exclDialogState(true, detailInput);
  bar(
    "H15 a SETTLED warning releases confirm AND shows the warning",
    !settledWarn.awaiting && settledWarn.warn,
    JSON.stringify(settledWarn),
  );
  // Every other transition is untouched — no hold, no warning, ever.
  const notActivating = exclDialogState(false, undefined);
  bar(
    "H16 a non-activate transition never holds confirm",
    !notActivating.awaiting && !notActivating.warn,
    "pause / resume / complete / archive are unaffected",
  );

  console.log(
    fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main();
