import "./_env-preload";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { kickoffStageSend } from "@/lib/sends/kickoff";

class Rollback extends Error {}

async function main() {
  const org = (await db.execute(sql`SELECT org_id FROM campaigns WHERE id = 110`)) as unknown as { org_id: string }[];
  const orgId = org[0].org_id;
  const t0 = Date.now();
  try {
    await db.transaction(async (tx) => {
      const res = await kickoffStageSend(tx, { orgId, campaignId: 110, stageId: 146 });
      const ms = Date.now() - t0;
      console.log(`kickoff: ${JSON.stringify(res)} in ${ms}ms`);
      if (!("ok" in res) || !res.ok) throw new Rollback();

      // Correctness checks INSIDE the tx (rolled back after).
      const checks = (await tx.execute(sql`
        SELECT
          count(*)::int AS n,
          count(*) FILTER (WHERE status='pending')::int AS pending,
          count(*) FILTER (WHERE link_id IS NOT NULL)::int AS with_link,
          count(*) FILTER (WHERE rendered_text LIKE '%/r/%')::int AS with_url,
          count(DISTINCT link_id)::int AS distinct_links,
          count(DISTINCT id)::int AS distinct_ids
        FROM stage_sends WHERE stage_id = 146
      `)) as unknown as Record<string, unknown>[];
      console.log("stage_sends checks:", JSON.stringify(checks[0]));

      const links = (await tx.execute(sql`
        SELECT count(*)::int AS n, count(DISTINCT code)::int AS distinct_codes,
               count(DISTINCT destination_id)::int AS distinct_dest
        FROM links WHERE stage_id = 146
      `)) as unknown as Record<string, unknown>[];
      console.log("links checks:", JSON.stringify(links[0]));

      const sample = (await tx.execute(sql`
        SELECT rendered_text FROM stage_sends WHERE stage_id = 146 LIMIT 1
      `)) as unknown as { rendered_text: string }[];
      console.log("sample rendered_text:\n---\n" + sample[0].rendered_text + "\n---");

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) { console.error("THREW:", e); process.exit(1); }
  }
  console.log(`Total (rolled back) ${Date.now() - t0}ms — nothing persisted.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
