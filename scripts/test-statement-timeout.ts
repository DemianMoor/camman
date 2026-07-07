// Unit test for isStatementTimeout — the helper that detects a Postgres
// statement_timeout (SQLSTATE 57014) anywhere in an error's cause chain.
// Pure function, no DB. Run: npx tsx scripts/test-statement-timeout.ts
import "./_env-preload";
import { isStatementTimeout } from "@/lib/db/statement-timeout";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  console.log((cond ? "  \x1b[32m✓\x1b[0m " : "  \x1b[31m✗\x1b[0m ") + name);
  if (cond) passed++;
  else failed++;
}

// The real shape from postgres-js via drizzle: the wrapper message is
// "Failed query: …" and the 57014 code lives on `.cause`. This is exactly the
// case the old `err.message`-only check missed.
const drizzleWrapped = Object.assign(
  new Error("Failed query: \n  with q as (...)\nparams: 235,..."),
  {
    cause: Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" },
    ),
  },
);
check("drizzle-wrapped 57014 on cause → true", isStatementTimeout(drizzleWrapped) === true);

// A bare driver error carrying the code directly.
check(
  "direct { code: 57014 } → true",
  isStatementTimeout(Object.assign(new Error("x"), { code: "57014" })) === true,
);

// Older shape where the message itself carried the text (message fallback).
check(
  "message contains 'statement timeout' → true",
  isStatementTimeout(new Error("... canceling statement due to statement timeout")) === true,
);

// Deeper nesting still detected.
check(
  "nested cause chain → true",
  isStatementTimeout({ message: "a", cause: { message: "b", cause: { code: "57014" } } }) === true,
);

// A genuine, non-timeout error MUST still surface (return false → re-thrown).
check(
  "unrelated error → false (still surfaces)",
  isStatementTimeout(new Error("null value violates not-null constraint")) === false,
);
check(
  "syntax error code 42601 → false",
  isStatementTimeout(Object.assign(new Error("syntax error"), { code: "42601" })) === false,
);

// Degenerate inputs never throw and are not timeouts.
check("null → false", isStatementTimeout(null) === false);
check("undefined → false", isStatementTimeout(undefined) === false);
check("string → false", isStatementTimeout("boom") === false);

// A cyclic cause chain must not loop forever.
const cyclic = new Error("loop") as Error & { cause?: unknown };
cyclic.cause = cyclic;
check("cyclic cause chain terminates → false", isStatementTimeout(cyclic) === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
