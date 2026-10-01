import "./_env-preload";

// Task 2 parity harness (plan docs/superpowers/plans/2026-09-30-audience-
// preview-task2-plan.md, T1 + [change 3]).
//
// PARITY (default): picks real recent campaign recipes covering the plan's
// scope list, prints them, then for each runs the FROZEN reference
// (lib/audience-preview-reference) and the LIVE previewAudience inside ONE
// read-only REPEATABLE READ transaction — both read the same snapshot — and
// diffs every field. Any difference fails the run.
//
//   A harness that has never been red proves nothing, so every run also
//   perturbs each numeric field of each reference result by one and requires
//   the differ to name exactly that field.
//
// SEGMENT GATE (--timing): for ≥ 5 recipes that select segments, times segment
// evaluation alone vs the whole preview (today's code = the reference),
// interleaved, EXPLAIN (ANALYZE, BUFFERS). If segment evaluation is more than
// half the wall time on the median segment recipe, STOP before T2 — narrowing
// by chips would not be the right fix for most real recipes.
//
// ⚠️ PRODUCTION ONLY IN THE QUIET WINDOW (05:00–06:00 UTC), enforced below: a
// database that is not the one in .env.demo is treated as production, the run
// refuses to start outside 05:00–05:45, and stops taking new work at 06:00.
// Everything is read-only: the transaction is READ ONLY, and the only SQL in
// this file is the recipe listing.
//
//   production: npx tsx --conditions=react-server scripts/verify-preview-parity.ts [--timing]
//   preview:    node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/verify-preview-parity.ts

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  combinePreviewParts,
  previewAudience,
  previewAudienceBase,
  type AudienceFilters,
  type AudiencePreviewInput,
} from "@/lib/audience-snapshot";
import {
  referencePreviewAudience,
  type PreviewRunner,
} from "@/lib/audience-preview-reference";
import {
  contactGroupSizes,
  explainSegmentEvaluation,
  harnessRunner,
  type PlanStats,
} from "@/lib/audience-preview-reference/timing";

const TIMING = process.argv.includes("--timing");
// Parity on the synthesized variants only — for re-running a scope gap inside
// the quiet window without repeating every real recipe.
const ONLY_VARIANTS = process.argv.includes("--only-variants");
// Print the scope and stop: no preview runs.
const SCOPE_ONLY = process.argv.includes("--scope-only");
// Generous on purpose: today's heaviest recipe runs ~37 s, past the
// production 30 s. The harness needs its numbers; each timing says whether
// production would have timed out.
const CEILING_MS = 120_000;
const PROD_TIMEOUT_MS = 30_000;
const MIN_RECIPES = 10;
const MIN_SEGMENT_RECIPES = 5;
const LARGE_GROUP = 500_000;
const SMALL_GROUP = 20_000;
// A share measured on a sub-100 ms query is noise, not a finding.
const MEASURABLE_MS = 100;

// ── world-state: which database, and may we run now ─────────────────────────
const refOf = (url: string | undefined) => {
  try {
    const u = new URL(url ?? "");
    return u.username.split(".")[1] ?? u.hostname;
  } catch {
    return "unknown";
  }
};
const dbRef = refOf(process.env.DATABASE_URL);
const demoFile = resolve(process.cwd(), ".env.demo");
const previewRef = existsSync(demoFile)
  ? refOf(
      readFileSync(demoFile, "utf8")
        .split("\n")
        .find((l) => l.startsWith("DATABASE_URL="))
        ?.slice("DATABASE_URL=".length)
        .trim()
        .replace(/^["']|["']$/g, ""),
    )
  : null;
const isPreview = previewRef != null && dbRef === previewRef;
const utcMinutes = () => {
  const d = new Date();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const WINDOW_START = 5 * 60;
const WINDOW_LAST_START = 5 * 60 + 45;
const WINDOW_END = 6 * 60;
const pastWindow = () => !isPreview && utcMinutes() >= WINDOW_END;

// ── recipes ─────────────────────────────────────────────────────────────────
type Tag =
  | "lc_hot_warm"
  | "lc_cold"
  | "lc_freeze"
  | "lc_new"
  | "lc_multi_chip"
  | "legacy"
  | "segments"
  | "group_small"
  | "group_large"
  | "prior_offer_on"
  | "prior_offer_off"
  | "offer_rules_on"
  | "offer_with_history"
  | "offer_no_history"
  | "cap"
  | "carrier"
  | "in_use_on"
  | "in_use_off";
const REQUIRED: Tag[] = [
  "lc_hot_warm",
  "lc_cold",
  "lc_freeze",
  "lc_new",
  "lc_multi_chip",
  "segments",
  "group_small",
  "group_large",
  "prior_offer_on",
  "prior_offer_off",
  "offer_rules_on",
  "offer_with_history",
  "offer_no_history",
  "cap",
  "carrier",
  "in_use_on",
  "in_use_off",
];

interface Recipe {
  label: string;
  input: AudiencePreviewInput;
  tags: Set<Tag>;
  offerHistory: number | null;
}

interface CampaignRow {
  id: number;
  org_id: string;
  lifecycle_rules: boolean;
  audience_segment_ids: number[] | null;
  audience_exclude_segment_ids: number[] | null;
  audience_contact_group_ids: number[] | null;
  audience_filters: AudienceFilters | null;
  audience_cap: number | null;
  exclude_in_use_contacts: boolean;
  exclude_prior_offer_contacts: boolean;
  offer_rules_enabled: boolean;
  offer_cooldown_days: number;
  offer_limit_times: number;
  offer_id: number | null;
  offer_history: number | null;
}

function tagsOf(
  input: AudiencePreviewInput,
  groupSize: (id: number) => number,
  offerHistory: number | null,
): Set<Tag> {
  const t = new Set<Tag>();
  const chips = input.lifecycleRules
    ? (input.filters.lifecycle_statuses ?? [])
    : [];
  if (!input.lifecycleRules) t.add("legacy");
  if (chips.includes("hot") || chips.includes("warm")) t.add("lc_hot_warm");
  if (chips.includes("cold")) t.add("lc_cold");
  if (chips.includes("freeze")) t.add("lc_freeze");
  if (chips.includes("new")) t.add("lc_new");
  if (chips.length >= 3) t.add("lc_multi_chip");
  if (input.segmentIds.length > 0) t.add("segments");
  const sizes = (input.contactGroupIds ?? []).map(groupSize);
  // LARGE is the COMBINED selection: no single production group reaches 500K
  // (largest 230K on 2026-10-01); the plan's "646 K" case is groups 3+1+4+2.
  if (sizes.reduce((a, n) => a + n, 0) >= LARGE_GROUP) t.add("group_large");
  if (sizes.length > 0 && sizes.every((n) => n <= SMALL_GROUP))
    t.add("group_small");
  const prior = input.excludePriorOffer === true && input.offerId != null;
  t.add(prior ? "prior_offer_on" : "prior_offer_off");
  if (prior && input.lifecycleRules && input.offerRulesEnabled)
    t.add("offer_rules_on");
  if (prior && (offerHistory ?? 0) > 0) t.add("offer_with_history");
  if (prior && (offerHistory ?? 0) === 0) t.add("offer_no_history");
  if (input.cap != null) t.add("cap");
  if ((input.filters.carrier_filter ?? []).length > 0) t.add("carrier");
  t.add(input.excludeInUse ? "in_use_on" : "in_use_off");
  return t;
}

async function loadRecipes(): Promise<Recipe[]> {
  // The only SQL in this file: a read of recent campaign configurations, plus
  // each campaign's offer history from the maintained counter (a single-row
  // lookup, never a count over history).
  const rows = (await db.execute(sql`
    select c.id, c.org_id, c.lifecycle_rules, c.audience_segment_ids,
           c.audience_exclude_segment_ids, c.audience_contact_group_ids,
           c.audience_filters, c.audience_cap, c.exclude_in_use_contacts,
           c.exclude_prior_offer_contacts, c.offer_rules_enabled,
           c.offer_cooldown_days, c.offer_limit_times, c.offer_id,
           oec.distinct_contacts::int as offer_history
    from campaigns c
    left join offer_exposure_counts oec
      on oec.org_id = c.org_id and oec.offer_id = c.offer_id
    where coalesce(cardinality(c.audience_segment_ids), 0)
        + coalesce(cardinality(c.audience_contact_group_ids), 0) > 0
    order by c.created_at desc
    limit 300
  `)) as unknown as CampaignRow[];
  // An offer with no history at all, for the one scope item real campaigns
  // rarely carry (plan recon: 3 of 26 active offers).
  const fresh = (await db.execute(sql`
    select o.org_id, o.id
    from offers o
    left join offer_exposure_counts oec
      on oec.org_id = o.org_id and oec.offer_id = o.id
    where coalesce(oec.distinct_contacts, 0) = 0
    order by o.created_at desc
    limit 1
  `)) as unknown as { org_id: string; id: number }[];

  const groupsByOrg = new Map<string, Set<number>>();
  for (const r of rows)
    for (const g of r.audience_contact_group_ids ?? [])
      (groupsByOrg.get(r.org_id) ?? groupsByOrg.set(r.org_id, new Set()).get(r.org_id)!).add(g);
  const sizes = new Map<string, number>();
  for (const [org, ids] of groupsByOrg)
    for (const [id, n] of await contactGroupSizes(db, org, [...ids]))
      sizes.set(`${org}:${id}`, n);

  const toInput = (r: CampaignRow): AudiencePreviewInput => ({
    orgId: r.org_id,
    lifecycleRules: r.lifecycle_rules === true,
    segmentIds: r.audience_segment_ids ?? [],
    excludeSegmentIds: r.audience_exclude_segment_ids ?? [],
    contactGroupIds: r.audience_contact_group_ids ?? [],
    filters: r.audience_filters ?? {},
    cap: r.audience_cap ?? null,
    excludeInUse: r.exclude_in_use_contacts === true,
    excludePriorOffer: r.exclude_prior_offer_contacts === true,
    offerRulesEnabled: r.offer_rules_enabled === true,
    offerCooldownDays: r.offer_cooldown_days,
    offerLimitTimes: r.offer_limit_times,
    offerId: r.offer_id,
  });
  const keyOf = (i: AudiencePreviewInput) => JSON.stringify(i);
  const all: Recipe[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const input = toInput(r);
    if (seen.has(keyOf(input))) continue;
    seen.add(keyOf(input));
    all.push({
      label: `campaign ${r.id}`,
      input,
      tags: tagsOf(input, (g) => sizes.get(`${r.org_id}:${g}`) ?? 0, r.offer_history),
      offerHistory: r.offer_history,
    });
  }

  // Greedy cover: take the recipe that covers the most still-uncovered tags.
  const picked: Recipe[] = [];
  const covered = new Set<Tag>();
  for (;;) {
    let best: Recipe | null = null;
    let bestGain = 0;
    for (const r of all) {
      if (picked.includes(r)) continue;
      const gain = REQUIRED.filter((t) => r.tags.has(t) && !covered.has(t)).length;
      if (gain > bestGain) [best, bestGain] = [r, gain];
    }
    if (!best) break;
    picked.push(best);
    best.tags.forEach((t) => covered.add(t));
  }
  // Variants for scope items no real recipe carries, each derived from a real
  // one by flipping exactly one knob — named as a variant in the scope print.
  const base = picked.find((r) => r.tags.has("prior_offer_on")) ?? picked[0];
  // A variant keeps the base offer's history unless it swaps the offer. The
  // old default of null tagged every variant "offer with no history" - on
  // 2026-10-01 that falsely covered offer_no_history with an offer that has one.
  const variant = (
    label: string,
    patch: Partial<AudiencePreviewInput>,
    offerHistory: number | null = base.offerHistory,
  ) => {
    const input = { ...base.input, ...patch };
    const orgId = input.orgId;
    picked.push({
      label: `${base.label} VARIANT: ${label}`,
      input,
      tags: tagsOf(input, (g) => sizes.get(`${orgId}:${g}`) ?? 0, offerHistory),
      offerHistory,
    });
  };
  if (base && !picked.some((r) => r.tags.has("in_use_off")))
    variant("exclude_in_use off", { excludeInUse: false });
  if (base && !picked.some((r) => r.tags.has("in_use_on")))
    variant("exclude_in_use on", { excludeInUse: true });
  if (base && !picked.some((r) => r.tags.has("lc_multi_chip")) && base.input.lifecycleRules)
    variant("chips hot,warm,cold", {
      filters: { ...base.input.filters, lifecycle_statuses: ["hot", "warm", "cold"] },
    });
  if (base && !picked.some((r) => r.tags.has("group_large"))) {
    // The largest groups this org's recent campaigns use, until the
    // combined selection reaches LARGE_GROUP.
    const ranked = [...sizes]
      .filter(([k]) => k.startsWith(`${base.input.orgId}:`))
      .sort((a, b) => b[1] - a[1]);
    const ids: number[] = [];
    let total = 0;
    for (const [k, n] of ranked) {
      if (total >= LARGE_GROUP) break;
      ids.push(Number(k.split(":")[1]));
      total += n;
    }
    if (total >= LARGE_GROUP)
      variant(`groups ${ids.join(",")} (${total} memberships)`, { contactGroupIds: ids, segmentIds: [] });
  }
  if (base && !picked.some((r) => r.tags.has("cap")))
    variant("cap 1000", { cap: 1000 });
  if (base && !picked.some((r) => r.tags.has("offer_no_history")) && fresh[0] && fresh[0].org_id === base.input.orgId)
    variant(`offer ${fresh[0].id} (no history)`, { offerId: fresh[0].id, excludePriorOffer: true }, 0);
  // Pad to the minimums: segment recipes first, then anything.
  for (const r of all) {
    if (picked.filter((p) => p.tags.has("segments")).length >= MIN_SEGMENT_RECIPES) break;
    if (!picked.includes(r) && r.tags.has("segments")) picked.push(r);
  }
  for (const r of all) {
    if (picked.length >= MIN_RECIPES) break;
    if (!picked.includes(r)) picked.push(r);
  }
  return picked;
}

// ── the differ, and its own red proof ───────────────────────────────────────
function leaves(o: unknown, path = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (o !== null && typeof o === "object") {
    for (const k of Object.keys(o as object).sort())
      for (const [p, v] of leaves((o as Record<string, unknown>)[k], path ? `${path}.${k}` : k))
        out.set(p, v);
  } else out.set(path, o);
  return out;
}
function diff(a: unknown, b: unknown): string[] {
  const la = leaves(a);
  const lb = leaves(b);
  const keys = new Set([...la.keys(), ...lb.keys()]);
  return [...keys].filter((k) => la.get(k) !== lb.get(k)).sort();
}
/** Every numeric field, bumped by one, must be named by the differ — alone. */
function differSelfTest(result: unknown): string[] {
  const failures: string[] = [];
  for (const [path, v] of leaves(result)) {
    if (typeof v !== "number") continue;
    const clone = JSON.parse(JSON.stringify(result));
    const parts = path.split(".");
    let node = clone;
    for (const p of parts.slice(0, -1)) node = node[p];
    node[parts.at(-1)!] = v + 1;
    const d = diff(result, clone);
    if (d.length !== 1 || d[0] !== path) failures.push(path);
  }
  return failures;
}

// ── runs ────────────────────────────────────────────────────────────────────
const READ_ONLY_RR = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;
const asRunner = (tx: unknown) => tx as PreviewRunner;

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const describe = (i: AudiencePreviewInput) =>
  [
    i.lifecycleRules ? `chips=[${(i.filters.lifecycle_statuses ?? []).join(",")}]` : "legacy",
    i.segmentIds.length ? `seg=[${i.segmentIds}]` : "",
    i.excludeSegmentIds?.length ? `excl=[${i.excludeSegmentIds}]` : "",
    i.contactGroupIds?.length ? `grp=[${i.contactGroupIds}]` : "",
    i.excludePriorOffer ? `offer=${i.offerId}${i.offerRulesEnabled ? ` rules(${i.offerCooldownDays}d/${i.offerLimitTimes}x)` : " ever"}` : "",
    i.cap != null ? `cap=${i.cap}` : "",
    i.filters.carrier_filter?.length ? `carrier=[${i.filters.carrier_filter}]` : "",
    `in_use=${i.excludeInUse ? "on" : "off"}`,
  ]
    .filter(Boolean)
    .join(" ");

async function parity(recipes: Recipe[]) {
  let compared = 0;
  let nonEmpty = 0;
  let differing = 0;
  let combinedDiffering = 0;
  let selfTestFailures = 0;
  for (const [n, r] of recipes.entries()) {
    if (pastWindow()) {
      console.log(`\n⚠️ 06:00 UTC reached — stopping before recipe ${n + 1}.`);
      break;
    }
    const runner = (tx: unknown) => harnessRunner(asRunner(tx), { ceilingMs: CEILING_MS });
    const t: Record<string, number> = {};
    const [ref, live, basePart] = await db.transaction(async (tx) => {
      const run = async (which: "ref" | "live") => {
        const t0 = performance.now();
        const out =
          which === "ref"
            ? await referencePreviewAudience(r.input, runner(tx))
            : await previewAudience(r.input, runner(tx));
        t[which] = performance.now() - t0;
        return out;
      };
      // Alternate the order so neither side always runs on the warmer cache.
      // Task 2's base part, in the SAME snapshot, for the combined comparison.
      const runBase = async () => {
        const t0 = performance.now();
        const out = await previewAudienceBase(r.input, runner(tx));
        t.base = performance.now() - t0;
        return out;
      };
      if (n % 2 === 0) {
        const a = await run("ref");
        const b = await run("live");
        return [a, b, await runBase()] as const;
      }
      const b = await run("live");
      const a = await run("ref");
      return [a, b, await runBase()] as const;
    }, READ_ONLY_RR);
    compared++;
    if (ref.total_matching > 0) nonEmpty++;
    const d = diff(ref, live);
    if (d.length > 0) differing++;
    // Task 2 bar 1 on real recipes: base + audience must equal the reference.
    // The audience part's own group-level fields are poisoned first, so a
    // combine that ignored the base could not pass.
    const poisoned = JSON.parse(JSON.stringify(live));
    poisoned.excluded_for_optout = -1;
    if (poisoned.lifecycle) {
      poisoned.lifecycle.excluded.opted_out = -1;
      poisoned.lifecycle.excluded.suppressed = -1;
      poisoned.lifecycle.excluded.status_not_selected = -1;
    }
    const dc = diff(
      ref,
      combinePreviewParts(basePart, poisoned, r.input.filters.lifecycle_statuses ?? []),
    );
    if (dc.length > 0) combinedDiffering++;
    const st = differSelfTest(ref);
    selfTestFailures += st.length;
    const slow = (ms: number) => (ms > PROD_TIMEOUT_MS ? " ⚠️>30s" : "");
    console.log(
      `  ${d.length === 0 ? "=" : "≠"} [${n + 1}] ${r.label}: total ${ref.total_matching}` +
        ` · ref ${(t.ref / 1000).toFixed(1)}s${slow(t.ref)} · live ${(t.live / 1000).toFixed(1)}s${slow(t.live)}` +
        ` · base ${(t.base / 1000).toFixed(1)}s${dc.length ? ` · COMBINED ≠ ${dc.join(",")}` : ""}` +
        (d.length ? `\n      differs: ${d.map((p) => `${p} ${JSON.stringify(leaves(ref).get(p))}→${JSON.stringify(leaves(live).get(p))}`).join(", ")}` : ""),
    );
  }
  console.log("");
  bar(`at least ${MIN_RECIPES} recipes compared`, compared >= MIN_RECIPES, `${compared}`);
  bar(
    `at least ${MIN_SEGMENT_RECIPES} of them select segments`,
    recipes.slice(0, compared).filter((r) => r.tags.has("segments")).length >= MIN_SEGMENT_RECIPES,
  );
  bar("the differ names every one-unit change, and only it (self red-proof)", selfTestFailures === 0, `${selfTestFailures} miss(es)`);
  // ⚠️ Two zeros agree about nothing — the same empty-scope lesson as the 4a
  // gate. Most recipes must have a real audience for agreement to mean anything.
  bar(
    "at least half the recipes have a non-empty audience",
    nonEmpty * 2 >= compared && nonEmpty > 0,
    `${nonEmpty} of ${compared}`,
  );
  bar("reference and live agree on every field of every recipe", compared > 0 && differing === 0, `${differing} of ${compared} differ`);
  bar(
    "base + audience parts (combined) agree with the reference on every recipe",
    compared > 0 && combinedDiffering === 0,
    `${combinedDiffering} of ${compared} differ`,
  );
}

async function segmentGate(recipes: Recipe[]) {
  const seg = recipes.filter((r) => r.tags.has("segments"));
  console.log(`\nSEGMENT GATE — ${seg.length} segment recipe(s), today's code (reference), interleaved, 2 rounds\n`);
  const fmt = (s: PlanStats) =>
    `${(s.execution_ms / 1000).toFixed(2)}s hit ${s.shared_hit} read ${s.shared_read}`;
  const shares: number[] = [];
  for (const [n, r] of seg.entries()) {
    if (pastWindow()) {
      console.log(`⚠️ 06:00 UTC reached — stopping before segment recipe ${n + 1}.`);
      break;
    }
    const rounds: { seg: PlanStats; full: PlanStats }[] = [];
    for (let round = 0; round < 2; round++) {
      const segStats = await db.transaction(
        (tx) => explainSegmentEvaluation(asRunner(tx), r.input, CEILING_MS),
        READ_ONLY_RR,
      );
      let full: PlanStats | null = null;
      await db.transaction(
        (tx) =>
          referencePreviewAudience(
            r.input,
            harnessRunner(asRunner(tx), { ceilingMs: CEILING_MS, onPlan: (s) => (full = s) }),
          ),
        READ_ONLY_RR,
      );
      rounds.push({ seg: segStats!, full: full! });
    }
    const share =
      rounds.reduce((a, x) => a + x.seg.execution_ms, 0) /
      rounds.reduce((a, x) => a + x.full.execution_ms, 0);
    const measurable = rounds.every((x) => x.full.execution_ms >= MEASURABLE_MS);
    if (measurable) shares.push(share);
    console.log(`  [${n + 1}] ${r.label} — ${describe(r.input)}`);
    rounds.forEach((x, i) =>
      console.log(`      round ${i + 1}: segments ${fmt(x.seg)} | whole preview ${fmt(x.full)}`),
    );
    console.log(
      `      segment share ${(share * 100).toFixed(0)}%${measurable ? "" : ` — NOT COUNTED, whole preview under ${MEASURABLE_MS} ms`}`,
    );
  }
  const sorted = [...shares].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : NaN;
  console.log("");
  bar(`at least ${MIN_SEGMENT_RECIPES} measurable segment recipes timed`, shares.length >= MIN_SEGMENT_RECIPES, `${shares.length}`);
  const dominates = median > 0.5;
  bar(
    "segment evaluation is at most half the wall time on the median segment recipe",
    Number.isFinite(median) && !dominates,
    `median share ${(median * 100).toFixed(0)}%`,
  );
  if (dominates)
    console.log("\n⛔ STOP — segment evaluation dominates. Report before T2 (plan [change 3]).");
}

async function main() {
  console.log(`database ${dbRef} (${isPreview ? "preview" : "PRODUCTION"})`);
  if (!isPreview) {
    const m = utcMinutes();
    if (m < WINDOW_START || m >= WINDOW_LAST_START) {
      console.error(
        `\nREFUSING — production runs only in the quiet window: start 05:00–05:45 UTC (now ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}).`,
      );
      process.exit(1);
    }
  }
  const all = await loadRecipes();
  const recipes = ONLY_VARIANTS ? all.filter((r) => r.label.includes("VARIANT")) : all;
  const covered = new Set(recipes.flatMap((r) => [...r.tags]));
  console.log(`\nSCOPE — ${recipes.length} recipe(s)`);
  for (const [n, r] of recipes.entries())
    console.log(`  [${n + 1}] ${r.label}\n      ${describe(r.input)}\n      tags: ${[...r.tags].join(" ")}`);
  const missing = REQUIRED.filter((t) => !covered.has(t));
  console.log("");
  bar("every scope item is covered by at least one recipe", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `${REQUIRED.length} items`);

  if (SCOPE_ONLY) {
    console.log("");
    console.log(
      fail === 0
        ? "Scope OK (--scope-only: nothing run)."
        : `${fail} check(s) FAILED.`,
    );
    process.exit(fail === 0 ? 0 : 1);
  }
  console.log(`\nPARITY — reference vs live, one READ ONLY REPEATABLE READ transaction per recipe\n`);
  await parity(recipes);
  if (TIMING) await segmentGate(recipes);

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
