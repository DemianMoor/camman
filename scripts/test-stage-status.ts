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
