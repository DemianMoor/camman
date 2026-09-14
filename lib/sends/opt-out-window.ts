// The opt-out attribution window, as a leaf module with NO imports, so read-only
// reporting (lib/reporting/grading.ts) can use it without loading the STOP
// ingester's send-side dependencies (alerts, credential decryption, drip
// lifecycle). A STOP credits the SINGLE most recent stage that sent to that
// number within this many hours — see lib/sends/poll-opt-outs.ts, which
// re-exports it for its existing importers.
export const OPT_OUT_ATTRIBUTION_WINDOW_HOURS = 72;
