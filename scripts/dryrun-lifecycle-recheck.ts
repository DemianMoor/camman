import "./_env-preload";

// DRY RUN of the send-time lifecycle re-check (PR 4c Task 3), against
// PRODUCTION. ⭐ IT WRITES NOTHING. It never claims a row, never sets
// 'sending', never sets 'skipped_ineligible'. Every statement is a SELECT.
//
// This is the evidence the owner's gate hangs off: before the re-check is
// allowed to drop anyone on a live send, we measure what it WOULD have
// dropped, over real claimed batches.
//
// ── WHY IT MIRRORS THE DRAIN'S CLAIM PREDICATE INSTEAD OF SAMPLING ──────────
// A dry run that invents its own batching measures a population the drain
// never sees. The claim below is the same predicate, the same ORDER BY and the
// same batch size as lib/sends/drain.ts — read it beside that file, not
// instead of it. The one deliberate difference is `FOR UPDATE SKIP LOCKED` and
// the UPDATE, which are omitted precisely because we must not take rows away
// from a real drain that may be running.
//
// ── THE STOP RULE ───────────────────────────────────────────────────────────
// If any single reason would skip MORE THAN ~10% of claimed rows, this script
// says STOP. The three layers are meant to remove a trickle at the margin,
// because Prepare already removed the bulk. A double-digit share means either
//   (a) the Prepare-time layer and the send-time layer DISAGREE — they read
//       different tables for freeze_not_due, deliberately, so a systematic gap
//       shows up here first; or
//   (b) the cadence is genuinely being violated across campaigns, which is a
//       real finding about how campaigns overlap, not a bug in this code.
// Either way the answer is to report it. ⚠️ DO NOT RAISE THE THRESHOLD TO MAKE
// THE RUN PASS.
//
// ── ≥3 BATCHES PER REASON ───────────────────────────────────────────────────
// A reason seen in one batch is an anecdote. Each reason reports how many
// batches contributed, and a reason that NEVER fires is reported as "never
// observed" rather than as a measured rate of 0 — `suppressed` is expected to
// be exactly that today, because nobody in the org has reached that status.
//
// Run it OFF the busy cron minutes (:29/:59 pools, :11/:41 fresh counts, :14
// creative lifetime, the */5 marks, :10/:25/:40/:55 engagement).
//
// Listed in EXCLUSIONS of scripts/test-preview-db-guard.ts: it reads
// production deliberately and carries no write token of its own.
//
// Run: npx tsx --conditions=react-server scripts/dryrun-lifecycle-recheck.ts
//      [--stage <id>] [--max-batches N]

import { sql } from "drizzle-orm";

// Mirrors lib/sends/drain.ts:284 (`opts.batchSize ?? 50`).
const BATCH_SIZE = 50;
const MIN_BATCHES_PER_REASON = 3;
const STOP_RULE_SHARE = 0.1;

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

const pct = (n: number, d: number) =>
  d === 0 ? "—" : `${((n / d) * 100).toFixed(2)}%`;

async function main() {
  const { db } = await import("@/db/client");
  const { recheckLifecycleEligibility } =
    await import("@/lib/sends/lifecycle-recheck");
  const { LIFECYCLE_EXCLUSION_KEYS } = await import("@/lib/sends/eligibility");

  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x")
    .hostname;
  const startedAt = new Date();
  console.log(
    `DRY RUN against ${host} — READ ONLY, nothing is claimed or written`,
  );
  console.log(
    `started ${startedAt.toISOString()} (minute :${startedAt.getUTCMinutes()})\n`,
  );

  // Candidate stages: any stage with pending rows. `lifecycle_rules` is false
  // everywhere today, so the re-check is evaluated as a HYPOTHETICAL by passing
  // lifecycleRules: true — exactly as the 4b merge-gate numbers were produced,
  // and without flipping a single campaign.
  const stageFilter = arg("stage");
  const stages = (await db.execute(sql`
    SELECT s.id AS stage_id, c.id AS campaign_id, c.org_id, c.offer_id,
           c.lifecycle_rules,
           count(ss.id)::int AS pending_rows
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    JOIN stage_sends ss ON ss.stage_id = s.id AND ss.status = 'pending'
    ${stageFilter ? sql`WHERE s.id = ${Number(stageFilter)}::int` : sql``}
    GROUP BY s.id, c.id, c.org_id, c.offer_id, c.lifecycle_rules
    ORDER BY count(ss.id) DESC
  `)) as unknown as {
    stage_id: number;
    campaign_id: number;
    org_id: string;
    offer_id: number | null;
    lifecycle_rules: boolean;
    pending_rows: number;
  }[];

  if (stages.length === 0) {
    console.log("No stage has pending rows right now — nothing to measure.");
    console.log(
      "⚠️ This is NOT a pass. Re-run when a stage is materialized and waiting to drain.",
    );
    process.exit(2);
  }

  console.log(
    `${stages.length} stage(s) with pending rows, ${stages.reduce((a, s) => a + s.pending_rows, 0)} rows total\n`,
  );

  const maxBatches = Number(arg("max-batches") ?? "0") || Infinity;
  let claimedTotal = 0;
  let batchesTotal = 0;
  const skipTotals: Record<string, number> = Object.fromEntries(
    LIFECYCLE_EXCLUSION_KEYS.map((k) => [k, 0]),
  );
  const batchesWithReason: Record<string, number> = Object.fromEntries(
    LIFECYCLE_EXCLUSION_KEYS.map((k) => [k, 0]),
  );
  const worstBatchShare: Record<string, number> = Object.fromEntries(
    LIFECYCLE_EXCLUSION_KEYS.map((k) => [k, 0]),
  );
  // ⭐ The freeze number on its own cannot tell the two explanations apart, so
  // compute the PREPARE-time predicate over the same batch and split it:
  //   both        — Prepare would also have caught it. On a real lifecycle
  //                 campaign these rows would never have been materialized, so
  //                 they are an artifact of measuring LEGACY batches.
  //   sendOnly    — ONLY the live signal catches it. This is the genuine
  //                 cross-campaign gap the re-check exists to close, and the
  //                 only part of the number that survives on a lifecycle
  //                 campaign.
  //   prepareOnly — Prepare would catch it but the live signal does not.
  let freezeBoth = 0;
  let freezeSendOnly = 0;
  let freezePrepareOnly = 0;
  let lifecycleCampaignRows = 0;

  for (const st of stages) {
    if (batchesTotal >= maxBatches) break;
    let offset = 0;
    for (;;) {
      if (batchesTotal >= maxBatches) break;
      // The drain's claim, minus FOR UPDATE SKIP LOCKED and the UPDATE. The
      // OFFSET stands in for rows the real drain would have removed from the
      // pending set by claiming them.
      const batch = (await db.execute(sql`
        SELECT id, phone, contact_id::text AS contact_id
        FROM stage_sends
        WHERE stage_id = ${st.stage_id} AND status = 'pending'
        ORDER BY created_at, id
        LIMIT ${BATCH_SIZE} OFFSET ${offset}
      `)) as unknown as { id: string; phone: string; contact_id: string }[];
      if (batch.length === 0) break;
      offset += batch.length;
      batchesTotal++;
      claimedTotal += batch.length;

      const skips = await recheckLifecycleEligibility(db, {
        orgId: st.org_id,
        campaignId: st.campaign_id,
        offerId: st.offer_id,
        // ⭐ The hypothetical, as an argument. No campaign row is touched.
        lifecycleRules: true,
        rows: batch,
      });

      if (st.lifecycle_rules) lifecycleCampaignRows += batch.length;

      // The PREPARE-time freeze predicate over the SAME batch: the stale
      // contact_engagement signal, which is what buildStageEligibilityExclusions
      // uses. One small query per batch, keyed by contact id.
      const prep = (await db.execute(sql`
        SELECT ce.contact_id::text AS contact_id
        FROM contact_engagement ce
        WHERE ce.org_id = ${st.org_id}::uuid
          AND ce.status = 'freeze'
          AND ce.last_sent_at IS NOT NULL
          AND ce.freeze_cadence_days IS NOT NULL
          AND ce.last_sent_at > now() - make_interval(days => ce.freeze_cadence_days)
          AND ce.contact_id IN (${sql.join(
            batch.map((b) => sql`${b.contact_id}::uuid`),
            sql`, `,
          )})
      `)) as unknown as { contact_id: string }[];
      const prepareFlagged = new Set(prep.map((r) => r.contact_id));
      for (const row of batch) {
        const sendFlagged = skips.get(row.id) === "freeze_not_due";
        const prepFlagged = prepareFlagged.has(row.contact_id);
        if (sendFlagged && prepFlagged) freezeBoth++;
        else if (sendFlagged) freezeSendOnly++;
        else if (prepFlagged) freezePrepareOnly++;
      }

      const perReason: Record<string, number> = {};
      for (const reason of skips.values()) {
        perReason[reason] = (perReason[reason] ?? 0) + 1;
      }
      for (const [reason, n] of Object.entries(perReason)) {
        skipTotals[reason] = (skipTotals[reason] ?? 0) + n;
        batchesWithReason[reason] = (batchesWithReason[reason] ?? 0) + 1;
        const share = n / batch.length;
        if (share > (worstBatchShare[reason] ?? 0)) {
          worstBatchShare[reason] = share;
        }
      }
    }
  }

  // ── the report ───────────────────────────────────────────────────────────
  console.log(
    `examined ${claimedTotal.toLocaleString()} row(s) across ${batchesTotal} batch(es) of ${BATCH_SIZE}\n`,
  );
  console.log("reason           would skip      share   batches   worst batch");
  console.log("─".repeat(66));
  let stop = false;
  let thin = false;
  for (const key of LIFECYCLE_EXCLUSION_KEYS) {
    const n = skipTotals[key] ?? 0;
    const b = batchesWithReason[key] ?? 0;
    if (n === 0) {
      // ⭐ Never observed is NOT a measured rate of 0. Say which it is.
      console.log(`${key.padEnd(16)} ${"—".padStart(10)}   never observed`);
      continue;
    }
    const share = n / claimedTotal;
    const flagStop = share > STOP_RULE_SHARE;
    const flagThin = b < MIN_BATCHES_PER_REASON;
    if (flagStop) stop = true;
    if (flagThin) thin = true;
    console.log(
      `${key.padEnd(16)} ${n.toLocaleString().padStart(10)}   ${pct(n, claimedTotal).padStart(7)}   ` +
        `${String(b).padStart(7)}${flagThin ? " ⚠️" : "  "}  ${pct(worstBatchShare[key] * 100, 100).padStart(7)}` +
        `${flagStop ? "   ⛔ OVER 10%" : ""}`,
    );
  }
  console.log("─".repeat(66));
  const totalSkipped = Object.values(skipTotals).reduce((a, b) => a + b, 0);
  console.log(
    `TOTAL            ${totalSkipped.toLocaleString().padStart(10)}   ${pct(totalSkipped, claimedTotal).padStart(7)}\n`,
  );

  // ⭐ NAME THE WORLD-STATE. Every row above sits on a campaign whose
  // lifecycle_rules is what it is TODAY. A batch materialized by a LEGACY
  // campaign never had the Prepare-time layers applied, so the re-check is
  // seeing people Prepare would have removed — which inflates the headline and
  // says nothing about the steady state.
  console.log(
    `corpus: ${claimedTotal.toLocaleString()} row(s), of which ${lifecycleCampaignRows.toLocaleString()} ` +
      `(${pct(lifecycleCampaignRows, claimedTotal)}) are on campaigns with lifecycle_rules ALREADY on.`,
  );
  if (lifecycleCampaignRows === 0) {
    console.log(
      `        ⚠️ NONE of them are. These batches were materialized WITHOUT the\n` +
        `        Prepare-time layers, so the freeze figure below is an UPPER BOUND,\n` +
        `        not the rate a real lifecycle campaign would see.`,
    );
  }
  console.log(
    `\nfreeze_not_due, split by which signal catches it:\n` +
      `  both signals      ${String(freezeBoth).padStart(7)}  ${pct(freezeBoth, claimedTotal).padStart(7)}  Prepare would have removed these first\n` +
      `  SEND-TIME ONLY    ${String(freezeSendOnly).padStart(7)}  ${pct(freezeSendOnly, claimedTotal).padStart(7)}  ⭐ the real cross-campaign gap\n` +
      `  Prepare only      ${String(freezePrepareOnly).padStart(7)}  ${pct(freezePrepareOnly, claimedTotal).padStart(7)}  stale signal, live one disagrees\n`,
  );

  if (thin) {
    console.log(
      `⚠️ A reason marked ⚠️ fired in fewer than ${MIN_BATCHES_PER_REASON} batches. That is an anecdote,\n` +
        `   not a rate — re-run over more pending rows before treating it as measured.`,
    );
  }
  if (stop) {
    console.log(
      `⛔ STOP RULE TRIPPED — a reason exceeds ${STOP_RULE_SHARE * 100}% of claimed rows.\n` +
        `   Report this before switching anything on. Do NOT raise the threshold.\n` +
        `   Either the Prepare-time and send-time layers disagree, or the cadence is\n` +
        `   genuinely being violated across campaigns. Both are findings, not tuning.`,
    );
  }
  console.log(
    `\nfinished ${new Date().toISOString()} — ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s. No rows were written.`,
  );
  process.exit(stop ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
