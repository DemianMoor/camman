/**
 * Supavisor exposes the SAME database on two ports: 6543 transaction-pooled,
 * 5432 session-pooled. Derive rather than adding an env var, so there is no
 * second connection string to set in Vercel, drift from DATABASE_URL, or fail
 * to rotate. A URL that is already session-mode or direct (port 5432) is passed
 * through untouched.
 *
 * `prepare=false` is a transaction-pooler workaround and is dropped here.
 *
 * Dependency-free on purpose: scripts that load `.env.local` with dotenv import
 * this, and must not pull in db/client before their env is set.
 */
export function toSessionModeUrl(raw: string): string {
  const url = new URL(raw);
  if (url.port === "6543") url.port = "5432";
  url.searchParams.delete("prepare");
  return url.toString();
}
