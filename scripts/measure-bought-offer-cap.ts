import "./_env-preload";

// SLOTS RECLAIMED BY EXCLUDING BUYERS BEFORE THE CAP — read-only, production.
//
// The plan's headline number: on real CAPPED LIFECYCLE campaigns, how many
// pooled contacts had already bought the offer, i.e. how many cap slots the
// change reclaims. That number is the entire justification — if it is ~0, say
// so plainly and let the owner decide whether to ship it at all.
//
// ⛔ DO NOT CREATE A CAMPAIGN TO UNBLOCK THIS (owner, 2026-09-25). The three
// will be ordinary daily campaigns once lifecycle is live. A campaign created
// to satisfy a measurement is a real campaign with a real frozen pool and real
// sends, and the number it produces describes that campaign rather than the
// operator's traffic. While fewer than three exist, the correct output is
// "not available yet" — not a manufactured figure.
//
// Every statement is a SELECT. Nothing is created, activated or modified.
//
// Run: npx tsx --conditions=react-server scripts/measure-bought-offer-cap.ts

async function main() {
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const { purchasedClause } = await import("@/lib/sale-attribution");

  const all = async <T>(q: ReturnType<typeof sql>): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x")
    .hostname;
  console.log(`read-only against ${host}\n`);

  // ── the population this change can reach ────────────────────────────────
  const pop = (
    await all<Record<string, string>>(sql`
      SELECT
        count(*) FILTER (WHERE lifecycle_rules)::text AS lifecycle_campaigns,
        count(*) FILTER (WHERE lifecycle_rules AND audience_cap IS NOT NULL)::text
          AS lifecycle_capped,
        count(*) FILTER (WHERE lifecycle_rules AND audience_cap IS NOT NULL
          AND offer_id IS NOT NULL)::text AS lifecycle_capped_with_offer,
        count(*) FILTER (WHERE audience_cap IS NOT NULL)::text AS capped_any,
        count(*)::text AS campaigns_total
      FROM campaigns`)
  )[0];
  console.log("POPULATION");
  for (const [k, v] of Object.entries(pop)) {
    console.log(`  ${k.padEnd(28)} ${Number(v).toLocaleString()}`);
  }

  // ── per capped lifecycle campaign: how many pooled contacts had bought ──
  const rows = await all<Record<string, string>>(sql`
    SELECT c.id::text AS campaign_id,
           c.human_id,
           c.status,
           c.audience_cap::text AS cap,
           c.created_at::text AS created_at,
           (SELECT count(*) FROM campaign_audience_pool p
             WHERE p.campaign_id = c.id)::text AS pooled,
           (SELECT count(*) FROM campaign_audience_pool p
             WHERE p.campaign_id = c.id
               AND EXISTS (
                 SELECT 1 FROM conversion_events ce
                 JOIN campaigns ca ON ca.id = ce.campaign_id
                 WHERE ce.org_id = c.org_id
                   AND ce.contact_id = p.contact_id
                   AND ca.offer_id = c.offer_id
                   AND ${purchasedClause()}
               ))::text AS pooled_buyers
    FROM campaigns c
    WHERE c.lifecycle_rules
      AND c.audience_cap IS NOT NULL
      AND c.offer_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM campaign_audience_pool p WHERE p.campaign_id = c.id)
    ORDER BY c.created_at
    LIMIT 10`);

  console.log(`\nCAPPED LIFECYCLE CAMPAIGNS WITH A FROZEN POOL: ${rows.length}`);
  if (rows.length === 0) {
    console.log(
      `\n  NOT AVAILABLE YET — no capped lifecycle campaign has a frozen pool.\n` +
        `  The plan requires the first THREE, and they must be ordinary daily\n` +
        `  campaigns. Nothing here manufactures one.`,
    );
  } else {
    const h = "campaign  human id              cap      pooled   buyers  slots reclaimed";
    console.log(h);
    console.log("-".repeat(h.length));
    for (const r of rows) {
      const pooled = Number(r.pooled);
      const buyers = Number(r.pooled_buyers);
      console.log(
        `${r.campaign_id.padStart(8)}  ${(r.human_id ?? "").padEnd(20)}  ` +
          `${Number(r.cap).toLocaleString().padStart(7)}  ` +
          `${pooled.toLocaleString().padStart(7)}  ` +
          `${buyers.toLocaleString().padStart(6)}  ` +
          `${buyers.toLocaleString().padStart(8)}` +
          `  (${pooled > 0 ? ((buyers / pooled) * 100).toFixed(2) : "0.00"}% of the pool)`,
      );
    }
    if (rows.length < 3) {
      console.log(
        `\n  ⚠️ ${rows.length} of the 3 the plan asks for. Partial, and reported as partial.`,
      );
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
