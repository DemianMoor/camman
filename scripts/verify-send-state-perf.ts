// Verify the send-state sent_today rewrite: (a) returns the SAME count as the
// old non-sargable query, and (b) now uses an index range scan. Read-only.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import postgres from "postgres";
import { campaignDayBoundsUtc } from "../lib/campaign-timezone";

const TZ = "America/New_York";

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  try {
    const org = (
      await pg`SELECT org_id FROM stage_sends GROUP BY org_id ORDER BY count(*) DESC LIMIT 1`
    )[0].org_id as string;

    // OLD query result
    const oldRows = await pg`
      SELECT count(*)::int AS n FROM stage_sends
      WHERE org_id = ${org} AND sent_at IS NOT NULL
        AND (sent_at AT TIME ZONE ${TZ})::date = (now() AT TIME ZONE ${TZ})::date`;
    // NEW query result (same bounds the app computes)
    const { start, end } = campaignDayBoundsUtc();
    const newRows = await pg`
      SELECT count(*)::int AS n FROM stage_sends
      WHERE org_id = ${org}
        AND sent_at >= ${start.toISOString()} AND sent_at < ${end.toISOString()}`;

    const oldN = oldRows[0].n as number;
    const newN = newRows[0].n as number;
    console.log("ET day bounds:", start.toISOString(), "→", end.toISOString());
    console.log("OLD count:", oldN, " NEW count:", newN, oldN === newN ? "✅ MATCH" : "❌ MISMATCH");

    // Plan + timing of the NEW query (median of 5)
    const times: number[] = [];
    let nodes = "";
    for (let i = 0; i < 5; i++) {
      const r = (await pg.unsafe(
        `EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*)::int AS n FROM stage_sends
         WHERE org_id = $1 AND sent_at >= $2 AND sent_at < $3`,
        [org, start.toISOString(), end.toISOString()] as never[],
      )) as unknown as Array<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown>; "Execution Time": number }> }>;
      times.push(r[0]["QUERY PLAN"][0]["Execution Time"]);
      if (i === 0) {
        const seen: string[] = [];
        const walk = (p: Record<string, unknown>) => {
          if (p["Node Type"]) seen.push(String(p["Node Type"]));
          const ch = p["Plans"];
          if (Array.isArray(ch)) ch.forEach((c) => walk(c as Record<string, unknown>));
        };
        walk(r[0]["QUERY PLAN"][0].Plan);
        nodes = seen.filter((n) => /Scan/.test(n)).join(", ");
      }
    }
    times.sort((a, b) => a - b);
    console.log(`NEW query median: ${times[2].toFixed(2)} ms  scan: ${nodes}`);
  } finally {
    await pg.end({ timeout: 5 });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
