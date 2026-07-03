// SUPERSEDED by scripts/test-resumable-materialization.ts.
//
// This script verified the OLD atomic kickoff by running it inside a rolled-back
// transaction. Kickoff is now WINDOWED + RESUMABLE — it opens its own transaction
// per window and COMMITS each, so it can't be wrapped in a caller's rollback (and
// it reads committed data). The resumable behavior (fresh materialize, resume
// after a budget cut, idempotent re-run, and the materialized_at completeness
// gate) is verified in scripts/test-resumable-materialization.ts against an
// isolated test stage with proper cleanup.
console.log(
  "verify-batch-kickoff is superseded — run scripts/test-resumable-materialization.ts",
);
