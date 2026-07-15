// Verifies migration 0109 landed: both new tables + their key columns, plus
// the new stage_sends index. information_schema only — no writes.
// Run: npx tsx scripts/test-ahoi-events-tables-columns.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

async function main() {
  const dlrCols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'ahoi_dlr_events'
  `;
  const dlrColNames = new Set(dlrCols.map((r) => r.column_name as string));
  check("ahoi_dlr_events exists", dlrCols.length > 0);
  for (const c of ["provider_uuid", "send_status", "smpp_status", "smpp_code", "matched_stage_send_id", "result", "processed_at"]) {
    check(`ahoi_dlr_events.${c} exists`, dlrColNames.has(c));
  }

  const inboundCols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'ahoi_inbound_events'
  `;
  const inboundColNames = new Set(inboundCols.map((r) => r.column_name as string));
  check("ahoi_inbound_events exists", inboundCols.length > 0);
  for (const c of ["source", "source_number", "destination_number", "provider_uuid", "matched_contact_id", "matched_stage_send_id", "result", "processed_at"]) {
    check(`ahoi_inbound_events.${c} exists`, inboundColNames.has(c));
  }

  const uniq = await sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'ahoi_inbound_events' AND indexname = 'ahoi_inbound_events_provider_uuid_uniq'
  `;
  check("ahoi_inbound_events provider_uuid partial unique index exists", uniq.length === 1);

  const stageSendsIdx = await sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'stage_sends' AND indexname = 'stage_sends_texthub_message_id_idx'
  `;
  check("stage_sends_texthub_message_id_idx exists", stageSendsIdx.length === 1);

  await sql.end();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main();
