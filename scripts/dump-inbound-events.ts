import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import postgres from "postgres";

// READ-ONLY. Dumps the most recent captured TextHub inbound callbacks
// (texthub_inbound_events) so the raw payload can be eyeballed right after
// texting STOP — this is how the (undocumented) callback contract is learned
// before Stage B parses it.
//
//   npx tsx scripts/dump-inbound-events.ts        # latest 5
//   npx tsx scripts/dump-inbound-events.ts 20     # latest 20
//
// Hand the printed `query` / `headers` / `raw_body` to Stage B as the source of
// truth for the parser. The script writes nothing.

interface EventRow {
  id: string;
  received_at: string;
  org_id: string;
  credential_id: number | null;
  provider_id: number | null;
  method: string;
  query: unknown; // jsonb
  headers: unknown; // jsonb
  raw_body: string | null;
  provider_message_id: string | null;
  result: string | null;
  processed_at: string | null;
}

function pretty(value: unknown): string {
  if (value === null || value === undefined) return "(null)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");

  const limitArg = Number(process.argv[2]);
  const limit = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : 5;

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  try {
    const rows = (await pg`
      SELECT id, received_at, org_id, credential_id, provider_id,
             method, query, headers, raw_body,
             provider_message_id, result, processed_at
      FROM texthub_inbound_events
      ORDER BY received_at DESC
      LIMIT ${limit}
    `) as unknown as EventRow[];

    if (rows.length === 0) {
      console.log(
        "No inbound events captured yet.\n" +
          "Register the STOP callback (Providers → key → STOP callback → Register),\n" +
          "then text STOP from your number, then re-run this script.",
      );
      return;
    }

    console.log(`Most recent ${rows.length} inbound TextHub event(s), newest first:\n`);
    for (const r of rows) {
      console.log("═".repeat(72));
      console.log(`id:            ${r.id}`);
      console.log(`received_at:   ${r.received_at}`);
      console.log(`method:        ${r.method}`);
      console.log(
        `org/cred/prov: ${r.org_id} / ${r.credential_id ?? "—"} / ${r.provider_id ?? "—"}`,
      );
      console.log(
        `stage-B fields: provider_message_id=${r.provider_message_id ?? "—"}  ` +
          `result=${r.result ?? "—"}  processed_at=${r.processed_at ?? "—"}`,
      );
      console.log(`\n── query (params TextHub appended) ──\n${pretty(r.query)}`);
      console.log(`\n── headers ──\n${pretty(r.headers)}`);
      console.log(`\n── raw_body ──\n${pretty(r.raw_body)}`);
      console.log("");
    }
    console.log("═".repeat(72));
    console.log(
      "\nTip: the phone number + keyword + a message id are what Stage B needs.\n" +
        "Look for them in query (GET callback) or raw_body (POST callback).",
    );
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Dump failed:", err);
  process.exit(1);
});
