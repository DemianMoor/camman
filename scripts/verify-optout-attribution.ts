import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import postgres from "postgres";

import {
  OPT_OUT_ATTRIBUTION_WINDOW_HOURS,
  parseProviderReceivedAt,
} from "../lib/sends/poll-opt-outs";

// Verifies the inbound-STOP → campaign/stage attribution building blocks
// (migration 0075) WITHOUT calling TextHub and WITHOUT leaving rows behind.
//   npx tsx scripts/verify-optout-attribution.ts

let failures = 0;
function check(name: string, cond: boolean) {
  console.log((cond ? "  ✓ " : "  ✗ ") + name);
  if (!cond) failures++;
}

async function main() {
  console.log("--- provider received_at parsing ---");
  // TextHub's documented shape "YYYY-MM-DD HH:MM:SS", parsed as UTC.
  const d = parseProviderReceivedAt("2026-06-04 03:54:10");
  check("parses TextHub timestamp", d !== null);
  check(
    "parses as UTC (no local-zone shift)",
    d?.toISOString() === "2026-06-04T03:54:10.000Z",
  );
  check("ISO 8601 with offset also parses", parseProviderReceivedAt("2026-06-04T03:54:10Z") !== null);
  check("null input ⇒ null", parseProviderReceivedAt(null) === null);
  check("garbage ⇒ null", parseProviderReceivedAt("not a date") === null);
  check("empty ⇒ null", parseProviderReceivedAt("") === null);

  console.log("\n--- window constant ---");
  check("window is 72h", OPT_OUT_ATTRIBUTION_WINDOW_HOURS === 72);

  console.log("\n--- attribution SQL smoke test ---");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  try {
    const tbl = (await pg`
      SELECT to_regclass('public.opt_out_attributions') IS NOT NULL AS present
    `) as unknown as { present: boolean }[];

    if (!tbl[0]?.present) {
      console.log("  ⚠ opt_out_attributions not found — migration 0075 not applied yet; skipping SQL smoke test");
    } else {
      const org = (await pg`SELECT id FROM organizations LIMIT 1`) as unknown as {
        id: string;
      }[];
      if (org.length === 0) {
        console.log("  ⚠ no organizations — skipping SQL smoke test");
      } else {
        const orgId = org[0].id;
        const anchor = new Date().toISOString();
        // Same shape as the live matcher; a phone that won't match → 0 rows, but
        // it proves the DISTINCT ON / interval window SQL parses and runs.
        const rows = (await pg`
          SELECT DISTINCT ON (stage_id)
                 id AS stage_send_id, stage_id, campaign_id, sent_at
          FROM stage_sends
          WHERE org_id = ${orgId}
            AND phone = ${"+10000000000"}
            AND status = 'sent'
            AND sent_at IS NOT NULL
            AND sent_at >= ${anchor}::timestamptz
                            - (${OPT_OUT_ATTRIBUTION_WINDOW_HOURS} * interval '1 hour')
            AND sent_at <= ${anchor}::timestamptz + interval '5 minutes'
          ORDER BY stage_id, sent_at DESC
        `) as unknown as unknown[];
        check("window SELECT runs (no SQL error)", Array.isArray(rows));

        const distinct = (await pg`
          SELECT count(DISTINCT oo.contact_id)::int AS n
          FROM opt_out_attributions oa
          JOIN opt_outs oo ON oo.id = oa.opt_out_id
          WHERE oa.org_id = ${orgId}
        `) as unknown as { n: number }[];
        check("campaign distinct-contact SELECT runs", typeof distinct[0]?.n === "number");
      }
    }
  } finally {
    await pg.end({ timeout: 5 });
  }

  console.log(
    failures === 0 ? "\nAll checks passed." : `\nFAILED: ${failures} check(s).`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Verify crashed:", err);
  process.exit(1);
});
