// Global send-dedup window — a phone number must not receive more than ONE
// message within this span, org-wide across every campaign/stage. Enforced as a
// HARD gate at send time in lib/sends/drain.ts: a claimed row whose phone was
// already `sent` within the window is marked 'skipped_duplicate' (terminal, not
// sent, not opted-out, not auto-retried) instead of being delivered.
//
// This is the safety net against ANY duplicate cause — a split-materialization
// bug, cross-campaign audience overlap, or a rapid intentional drip to the same
// people. Single source of truth so the span is changed in exactly one place.
export const SEND_DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
