// Unit test for deriveStageOperationalStatus + stageSendWarningCount.
// Pure functions, no DB. Run: npx tsx scripts/test-stage-status.ts
import "./_env-preload";
import {
  deriveStageOperationalStatus,
  stageSendWarningCount,
  type StageSendCounts,
} from "@/lib/stages/stage-status";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log((cond ? "  \x1b[32m✓\x1b[0m " : "  \x1b[31m✗\x1b[0m ") + name + (cond || !detail ? "" : ` — ${detail}`));
  if (cond) passed++;
  else failed++;
}

function counts(p: Partial<StageSendCounts>): StageSendCounts {
  return {
    pending: 0, sending: 0, sent: 0, failed: 0, skippedDuplicate: 0,
    ...p,
    total:
      (p.pending ?? 0) + (p.sending ?? 0) + (p.sent ?? 0) + (p.failed ?? 0) + (p.skippedDuplicate ?? 0),
  };
}
const base = { linkMode: "tracked", scheduledAt: "2026-07-07T13:30:00Z", scheduleMissedAt: null, materializedAt: "2026-07-07T12:00:00Z" };

// THE BUG: 2500 sent + 29 stuck 'sending', 0 pending → must be GREEN, not red "Failed".
check(
  "2500 sent + 29 sending, 0 pending → sending_sent (green), NOT missed_failed",
  deriveStageOperationalStatus({ ...base, sentAt: null, counts: counts({ sent: 2500, sending: 29 }) }) === "sending_sent",
);

// A few hard failures alongside a bulk send → still green (failures are a warning).
check(
  "2500 sent + 5 failed, 0 pending → sending_sent (green)",
  deriveStageOperationalStatus({ ...base, sentAt: "2026-07-07T13:31:00Z", counts: counts({ sent: 2500, failed: 5 }) }) === "sending_sent",
);

// Genuinely dead stage: nothing sent, only failures → red.
check(
  "0 sent + 5 failed, 0 pending → missed_failed (red)",
  deriveStageOperationalStatus({ ...base, sentAt: null, counts: counts({ failed: 5 }) }) === "missed_failed",
);

// Nothing sent, only dedup-skips → red.
check(
  "0 sent + 3 skippedDuplicate → missed_failed (red)",
  deriveStageOperationalStatus({ ...base, sentAt: null, counts: counts({ skippedDuplicate: 3 }) }) === "missed_failed",
);

// A missed schedule window still wins (red), even with sent rows.
check(
  "scheduleMissedAt set → missed_failed even if sent>0",
  deriveStageOperationalStatus({ ...base, scheduleMissedAt: "2026-07-07T14:00:00Z", sentAt: null, counts: counts({ sent: 100 }) }) === "missed_failed",
);

// Prepared (materialized, nothing sent yet, all pending) → blue.
check(
  "all pending, nothing sent → prepared (blue)",
  deriveStageOperationalStatus({ ...base, sentAt: null, counts: counts({ pending: 500 }) }) === "prepared",
);

// Actively sending (some pending, some sending) → green.
check(
  "pending + sending, 0 sent → sending_sent (green)",
  deriveStageOperationalStatus({ ...base, sentAt: null, counts: counts({ pending: 100, sending: 50 }) }) === "sending_sent",
);

// ---------------------------------------------------------------------------
// Materialization in progress vs. an ABORTED stage's audit residue.
//
// Abort (…/send/abort) resets materialized_at to NULL, cancels the pending rows
// to 'rejected', and deliberately KEEPS the 'skipped_opted_out' rows recorded at
// materialization time. That leaves "materialized_at NULL + rows exist" — the
// same shape as a live materialization — so a row-count predicate pinned the
// stage at Indigo "Materializing" forever with no Prepare action.
// ---------------------------------------------------------------------------
const unmat = { linkMode: "tracked", scheduledAt: "2026-07-26T22:00:00Z", scheduleMissedAt: null, materializedAt: null };

// Genuine in-flight materialization: rows are landing as 'pending'.
check(
  "materializedAt NULL + 900 pending → materializing (genuine, unchanged)",
  deriveStageOperationalStatus({ ...unmat, sentAt: null, counts: counts({ pending: 900 }) }) === "materializing",
);

// THE BUG: audit-only residue must not read as work in flight. `total` is set
// directly here (not via the counts() helper) to model a caller whose total
// still folds in audit rows.
const auditResidue: StageSendCounts = { total: 9, pending: 0, sending: 0, sent: 0, failed: 0, skippedDuplicate: 0 };
check(
  "aborted stage (materializedAt NULL, 0 live rows, audit residue) → NOT materializing",
  deriveStageOperationalStatus({ ...unmat, sentAt: null, counts: auditResidue }) !== "materializing",
  String(deriveStageOperationalStatus({ ...unmat, sentAt: null, counts: auditResidue })),
);
check(
  "…and reads scheduled_unprepared, so Prepare is offered again",
  deriveStageOperationalStatus({ ...unmat, sentAt: null, counts: auditResidue }) === "scheduled_unprepared",
  String(deriveStageOperationalStatus({ ...unmat, sentAt: null, counts: auditResidue })),
);
// Same signature with no schedule ⇒ back to draft, not a stuck spinner.
check(
  "aborted + unscheduled → draft",
  deriveStageOperationalStatus({ ...unmat, scheduledAt: null, sentAt: null, counts: auditResidue }) === "draft",
  String(deriveStageOperationalStatus({ ...unmat, scheduledAt: null, sentAt: null, counts: auditResidue })),
);
// Even a large residue can't strand it — the predicate is live rows, not volume.
check(
  "9,188 audit rows, 0 live → still scheduled_unprepared",
  deriveStageOperationalStatus({
    ...unmat,
    sentAt: null,
    counts: { total: 9188, pending: 0, sending: 0, sent: 0, failed: 0, skippedDuplicate: 0 },
  }) === "scheduled_unprepared",
);
// A resumed materialization that has produced live rows again still reports progress.
check(
  "residue + 50 pending (materialization resumed) → materializing",
  deriveStageOperationalStatus({
    ...unmat,
    sentAt: null,
    counts: { total: 9238, pending: 50, sending: 0, sent: 0, failed: 0, skippedDuplicate: 0 },
  }) === "materializing",
);

// Warning count = failed + sending + skippedDuplicate.
check(
  "stageSendWarningCount sums failed+sending+skippedDuplicate",
  stageSendWarningCount(counts({ sent: 2500, failed: 3, sending: 29, skippedDuplicate: 2 })) === 34,
  String(stageSendWarningCount(counts({ sent: 2500, failed: 3, sending: 29, skippedDuplicate: 2 }))),
);
check("stageSendWarningCount is 0 for a clean stage", stageSendWarningCount(counts({ sent: 100 })) === 0);
check("stageSendWarningCount handles null counts", stageSendWarningCount(null) === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
