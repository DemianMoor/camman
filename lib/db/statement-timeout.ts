// Detects a Postgres statement_timeout (SQLSTATE 57014) anywhere in an error's
// cause chain.
//
// Why the chain, not just err.message: postgres-js (via drizzle) wraps the
// driver error, so the thrown error's `message` is "Failed query: <sql>
// params: …" while the 57014 `code` and the "canceling statement due to
// statement timeout" text live on `err.cause`. A message-only check misses it,
// and callers that meant to degrade a timeout into a "truncated" preview
// instead re-throw it (500). Walk the chain, checking the code first with a
// message-substring fallback for older/unwrapped shapes. A `seen` set guards
// against a cyclic cause chain.
export function isStatementTimeout(err: unknown): boolean {
  const seen = new Set<unknown>();
  let e: unknown = err;
  while (e && typeof e === "object" && !seen.has(e)) {
    seen.add(e);
    const rec = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (rec.code === "57014") return true;
    if (
      typeof rec.message === "string" &&
      (rec.message.includes("statement timeout") || rec.message.includes("57014"))
    ) {
      return true;
    }
    e = rec.cause;
  }
  return false;
}
