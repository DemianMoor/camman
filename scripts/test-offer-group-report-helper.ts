import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import postgres from "postgres";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`✓ ${name}`); }
  else { failed++; console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  // Dynamic import (not a static top-level import): tsx/esbuild hoists static
  // ESM imports above interspersed statements, so a static import here would
  // evaluate lib/reporting/offer-group-report.ts (and its @/db/client import,
  // which reads process.env.DATABASE_URL at module-eval time) BEFORE the
  // dotenv config() above has populated process.env. Deferring the import to
  // inside main() — after config() has already run — sidesteps that. Same
  // queries/behavior as a static import, purely an ordering fix (mirrors the
  // main()-wrapper adaptation Task 1 needed for its own smoke script).
  const { getOfferGroupReport, refreshOfferGroupReport } = await import(
    "../lib/reporting/offer-group-report"
  );

  const db = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  // Resolve an org + offer that actually has report rows (offer 62 per the brief).
  const [own] = await db`select org_id from offers where id = 62 limit 1`;
  const orgId = own?.org_id as string | undefined;
  await db.end();
  if (!orgId) { console.log("SKIP: offer 62 not present in this DB"); process.exit(0); }

  await refreshOfferGroupReport(); // must not throw
  check("refresh completed", true);

  const rep = await getOfferGroupReport(orgId, 62);
  check("rows is array", Array.isArray(rep.rows));
  check("has benchmark", typeof rep.orgBenchmark.sends === "number");
  check("numbers are numeric", rep.rows.every(r =>
    typeof r.sends === "number" && typeof r.revenue === "number"));
  check("pressure <= 90d floor", rep.rows.every(r =>
    r.sent_7d <= r.sent_30d && r.sent_30d <= r.sent_90d));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
