// SUPERSEDED by scripts/test-resumable-materialization.ts.
//
// This script verified the OLD atomic kickoff (manual + tracked materialization,
// the already_pending refusal, and composer/URL contracts) inside a single
// rolled-back transaction. Kickoff is now WINDOWED + RESUMABLE — it commits per
// window and reads committed data, so a caller-rollback wrapper no longer works,
// and `already_pending` is gone (a re-run is now an idempotent no-op gated by
// materialized_at). Manual + tracked materialization, resume-after-budget,
// idempotency, and the no-early-send completeness gate are verified in
// scripts/test-resumable-materialization.ts against an isolated test stage with
// cleanup. Composer/URL parity is covered by verify-sms-preview + verify-mint.
console.log(
  "verify-send is superseded — run scripts/test-resumable-materialization.ts",
);
