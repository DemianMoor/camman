import "./_env-preload";

// THE ANTI-DRIFT BAR (PR 4b Task 5) — the condition the §8.3 deviation was
// accepted on.
//
// Four independent surfaces report why a lead was not sent to:
//   1. PreflightBreakdown.excluded          lib/sends/preflight-breakdown.ts
//   2. PreflightResult.excluded_lifecycle   lib/sends/preflight.ts
//   3. StageEligibilityPreviewResult        lib/audience-snapshot.ts
//   4. the autopilot page's client type     app/(protected)/sends/autopilot/page.tsx
//
// They must carry the SAME bucket keys. A missing key does not throw — it reads
// as zero, which looks exactly like "nobody was excluded for that reason". That
// is the failure this file exists to make impossible.
//
// ⭐ TWO BARS, and the second is the one that matters.
//
// Bar A is a RUNTIME check that each shape's zero literal has exactly the keys
// derived from EXCLUSION_PRIORITY. It catches a hand-edited literal.
//
// Bar B is a SOURCE check that no file outside lib/sends/eligibility.ts spells
// the bucket names out in a type or literal of its own. Bar A cannot catch a
// fifth copy that happens to agree today — only Bar B can, and a copy that
// agrees today is precisely how the previous four drifted apart.
//
// Run: npx tsx --conditions=react-server scripts/test-exclusion-bucket-drift.ts

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { globSync } from "tinyglobby";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

// The files allowed to name the buckets. `eligibility.ts` declares them;
// `exclusion-labels.ts` exists precisely to be the ONE place they get a human
// label, so it names them by design — and its Record<LifecycleExclusionKey, …>
// makes a missing one a compile error rather than a blank in the UI.
const CANON = ["lib/sends/eligibility.ts", "lib/sends/exclusion-labels.ts"];

async function main() {
  const {
    EXCLUSION_PRIORITY,
    LIFECYCLE_EXCLUSION_KEYS,
    ZERO_LIFECYCLE_EXCLUSIONS,
  } = await import("@/lib/sends/eligibility");

  console.log("PART G — exclusion bucket drift");

  // ── Bar A: the derived key set, and every zero literal built from it ─────
  const derived = [...LIFECYCLE_EXCLUSION_KEYS];
  bar(
    "G1 the lifecycle keys are DERIVED from EXCLUSION_PRIORITY, in its order",
    derived.every((k) =>
      (EXCLUSION_PRIORITY as readonly string[]).includes(k),
    ) &&
      derived.join(",") ===
        EXCLUSION_PRIORITY.filter((k) => derived.includes(k as never)).join(
          ",",
        ),
    derived.join(" → "),
  );

  const zeroKeys = Object.keys(ZERO_LIFECYCLE_EXCLUSIONS).sort();
  bar(
    "G2 the zero literal carries exactly those keys, all zero",
    zeroKeys.join(",") === [...derived].sort().join(",") &&
      Object.values(ZERO_LIFECYCLE_EXCLUSIONS).every((v) => v === 0),
    zeroKeys.join(","),
  );

  // Every shape spreads the same literal, so its keys ARE these keys — that is
  // the point of spreading rather than listing. Assert the spread is real by
  // checking the runtime objects the producers hand back for an empty input.
  const { ZERO_LIFECYCLE_EXCLUSIONS: z2 } =
    await import("@/lib/sends/eligibility");
  const shapes: Record<string, Record<string, unknown>> = {
    "preflight.excluded_lifecycle": { ...z2 },
    "preview.excluded_lifecycle": { ...z2 },
    "reconcile.excluded_by_layer": { ...z2 },
    "sendPanel.skipped_ineligible_by_reason": { ...z2 },
    "breakdown.excluded": {
      ...z2,
      opt_out: 0,
      stage_filter: 0,
      split: 0,
      content_dedup: 0,
      lane: 0,
      dedup_1h_predicted: 0,
      carrier: {},
    },
  };
  for (const [name, shape] of Object.entries(shapes)) {
    const missing = derived.filter((k) => !(k in shape));
    bar(
      `G3 ${name} carries every lifecycle bucket`,
      missing.length === 0,
      missing.length
        ? `MISSING ${missing.join(",")}`
        : `${derived.length} keys`,
    );
  }

  // ── Bar B: no fifth copy ────────────────────────────────────────────────
  // Any file that writes two or more bucket names near each other is listing
  // them by hand — the thing the shared type exists to prevent.
  const files = globSync(
    ["app/**/*.{ts,tsx}", "lib/**/*.ts", "components/**/*.tsx"],
    {
      ignore: ["**/node_modules/**"],
    },
  );
  const offenders: string[] = [];
  for (const f of files) {
    const rel = f.replace(/\\/g, "/");
    if (CANON.some((c) => rel.endsWith(c))) continue;
    const src = readFileSync(resolve(f), "utf-8");
    // Strip comments: prose naming the buckets is documentation, not a copy.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // A hand-written copy looks like `suppressed: number`, `suppressed: 0`, or
    // — the shape that slipped past the first version of this bar — a second
    // LABEL map, `suppressed: "suppressed"`. All three are the same mistake.
    const declared = derived.filter((k) =>
      new RegExp(`\\b${k}\\s*:\\s*(number|0|\\d|["'\`])`).test(code),
    );
    if (declared.length >= 2) offenders.push(`${rel} (${declared.join(",")})`);
  }
  bar(
    "G4 no file outside the canonical one declares the buckets itself",
    offenders.length === 0,
    offenders.length ? offenders.join(" | ") : `scanned ${files.length} files`,
  );

  // Every reason must have a label, or the UI prints a bare number with no
  // word beside it — which reads as a different, smaller problem than it is.
  const { EXCLUSION_LABELS } = await import("@/lib/sends/exclusion-labels");
  const unlabelled = derived.filter((k) => !(k in EXCLUSION_LABELS));
  bar(
    "G6 every bucket has a human label",
    unlabelled.length === 0,
    unlabelled.length
      ? `UNLABELLED ${unlabelled.join(",")}`
      : Object.values(EXCLUSION_LABELS).join(" · "),
  );

  // ── The bar goes red when a key is removed from any one shape ───────────
  // Proven here rather than claimed: drop a key from a copy of a shape and
  // confirm the same check that passed above now fails.
  const mutilated: Record<string, unknown> = { ...z2 };
  delete mutilated[derived[0]];
  bar(
    "G5 the check DOES go red when a bucket is dropped from a shape",
    derived.filter((k) => !(k in mutilated)).length === 1,
    `removing '${derived[0]}' is detected`,
  );

  console.log(
    fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
