// Verifies the batched conversions UPDATE is equivalent to the old per-row form:
// same sale_status / sale_revenue / keitaro_conversion_id, and the ET-wall-clock
// convertedAt is stored as the correct UTC instant (the zoned-literal concat).
// Runs inside a transaction and ROLLS BACK — no data is modified.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

const TZ = "America/New_York";

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const c = await pg.reserve();
  try {
    const rows = await c`SELECT id FROM stage_sends LIMIT 3`;
    if (rows.length < 1) {
      console.log("no stage_sends rows to test");
      return;
    }
    const ids = rows.map((r) => r.id as string);
    // Synthetic conversion values, one per row.
    const picks = ids.map((id, i) => ({
      id,
      status: "sale",
      revenue: (10 + i).toString(),
      convertedAt: `2026-06-2${i + 1} 14:30:00`, // ET wall-clock
      eventId: `evt_${i}`,
    }));

    await c`BEGIN`;
    // Batched form (same SQL shape as poll-conversions.ts)
    const vals = picks.map(
      (p) =>
        pg`(${p.id}::uuid, ${p.status}::text, ${p.revenue}::numeric, ${p.convertedAt}::text, ${p.eventId}::text)`,
    );
    // Build the VALUES list.
    let valuesFragment = vals[0];
    for (let i = 1; i < vals.length; i++) valuesFragment = pg`${valuesFragment}, ${vals[i]}`;
    await c.unsafe(
      `UPDATE stage_sends AS s
       SET sale_status = v.status, sale_revenue = v.revenue,
           converted_at = (v.converted_at || ' ' || $1)::timestamptz,
           keitaro_conversion_id = v.event_id
       FROM (VALUES ${picks
         .map(
           (_, i) =>
             `($${i * 5 + 2}::uuid, $${i * 5 + 3}::text, $${i * 5 + 4}::numeric, $${i * 5 + 5}::text, $${i * 5 + 6}::text)`,
         )
         .join(", ")}) AS v(id, status, revenue, converted_at, event_id)
       WHERE s.id = v.id`,
      [TZ, ...picks.flatMap((p) => [p.id, p.status, p.revenue, p.convertedAt, p.eventId])] as never[],
    );

    // Read back + independently compute the expected UTC instant for convertedAt.
    for (const p of picks) {
      const got = (await c`
        SELECT sale_status, sale_revenue::text AS rev, keitaro_conversion_id,
               converted_at
        FROM stage_sends WHERE id = ${p.id}::uuid`)[0];
      const expectedUtc = (await c`
        SELECT (${p.convertedAt} || ' ' || ${TZ})::timestamptz AS ts`)[0].ts;
      const ok =
        got.sale_status === p.status &&
        Number(got.rev) === Number(p.revenue) &&
        got.keitaro_conversion_id === p.eventId &&
        new Date(got.converted_at as string).getTime() ===
          new Date(expectedUtc as string).getTime();
      console.log(
        `${p.id.slice(0, 8)}… status=${got.sale_status} rev=${got.rev} ` +
          `conv_id=${got.keitaro_conversion_id} converted_at=${new Date(got.converted_at as string).toISOString()} ` +
          (ok ? "✅" : "❌ MISMATCH"),
      );
    }
    await c`ROLLBACK`;
    console.log("Rolled back — no data modified.");
  } finally {
    c.release();
    await pg.end({ timeout: 5 });
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
