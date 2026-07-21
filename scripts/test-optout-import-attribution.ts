// Integration checks for the timestamped opt-out attribution import
// (lib/sends/import-optout-attribution.ts, importOptOutsWithAttribution).
// Seeds a throwaway campaign + stages + sends under a real org INSIDE a
// transaction that is ALWAYS rolled back — no row survives, no real data is
// touched.
//
//   npx tsx scripts/test-optout-import-attribution.ts
//
// Covers the operator-specified rules:
//   1. Earliest-timestamp wins when the file lists a number twice.
//   2. A number that already has an opt_out is skipped (no new opt_out, no
//      re-attribution).
//   3. A number sent within 72h is mapped to the latest stage; the stage's
//      opt_out counters bump.
//   4. A number with no in-window send is suppressed but unattributed.
//   5. parseReplyTime honors the timezone for naive stamps + ISO offsets.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  importOptOutsWithAttribution,
  parseReplyTime,
} from "@/lib/sends/import-optout-attribution";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

const rollback = new Error("__rollback__");

// libphonenumber's metadata won't load under tsx (see the importer's note), so
// inject a passthrough validator: the test feeds already-E.164 numbers.
const passthroughValidate = (raw: string) =>
  /^\+\d{8,15}$/.test(raw.trim())
    ? { valid: true, normalized: raw.trim() }
    : { valid: false, normalized: null, error: "Invalid phone number" };

async function main() {
  // --- pure unit checks: parseReplyTime ---
  const et = parseReplyTime("2026-07-01 12:00:00", "America/New_York");
  check(
    "naive parsed in ET → 16:00Z (EDT −4)",
    et?.toISOString() === "2026-07-01T16:00:00.000Z",
    `got ${et?.toISOString()}`,
  );
  const mt = parseReplyTime("7/1/2026 12:00", "America/Denver");
  check(
    "US M/D/YYYY parsed in Mountain → 18:00Z (MDT −6)",
    mt?.toISOString() === "2026-07-01T18:00:00.000Z",
    `got ${mt?.toISOString()}`,
  );
  const iso = parseReplyTime("2026-07-01T12:00:00-04:00", "UTC");
  check(
    "ISO with offset ignores timezone arg → 16:00Z",
    iso?.toISOString() === "2026-07-01T16:00:00.000Z",
    `got ${iso?.toISOString()}`,
  );
  check("garbage timestamp → null", parseReplyTime("not a date", "UTC") === null);

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    const orgRows = (await db.execute(sql`
      SELECT id FROM organizations LIMIT 1
    `)) as unknown as { id: string }[];
    if (orgRows.length === 0) {
      console.log("⚠ no organizations in DB — cannot run DB checks; skipping.");
      await pg.end({ timeout: 5 });
      process.exit(failed === 0 ? 0 : 1);
    }
    const orgId = orgRows[0].id;

    try {
      await db.transaction(async (tx) => {
        // Reuse an existing brand to scope the imported opt-outs to (brands
        // carry extra required columns not worth reconstructing here).
        const brandRows = (await tx.execute(sql`
          SELECT id FROM brands WHERE org_id = ${orgId} ORDER BY id LIMIT 1
        `)) as unknown as { id: number }[];
        if (brandRows.length === 0) {
          console.log("⚠ org has no brands — cannot run DB checks; skipping.");
          throw rollback;
        }
        const brandId = brandRows[0].id;

        const camp = (await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name)
          VALUES (${orgId}, '__test_import_attr', '__test_import_attr')
          RETURNING id
        `)) as unknown as { id: number }[];
        const campaignId = camp[0].id;

        async function makeStage(n: number): Promise<number> {
          const r = (await tx.execute(sql`
            INSERT INTO campaign_stages (org_id, campaign_id, stage_number)
            VALUES (${orgId}, ${campaignId}, ${n})
            RETURNING id
          `)) as unknown as { id: number }[];
          return r[0].id;
        }
        async function makeSend(
          stageId: number,
          phone: string,
          sentAtIso: string,
        ): Promise<void> {
          const c = (await tx.execute(sql`
            INSERT INTO contacts (org_id, phone_number)
            VALUES (${orgId}, ${phone})
            ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now()
            RETURNING id
          `)) as unknown as { id: string }[];
          await tx.execute(sql`
            INSERT INTO stage_sends
              (org_id, campaign_id, stage_id, contact_id, phone,
               rendered_text, status, sent_at)
            VALUES (${orgId}, ${campaignId}, ${stageId}, ${c[0].id}, ${phone},
                    'x', 'sent', ${sentAtIso}::timestamptz)
          `);
        }

        const s1 = await makeStage(1);
        const s2 = await makeStage(2);

        // P1: sent by two stages; the reply lands ~30m after the s2 send.
        const P1 = "+15556660001";
        await makeSend(s1, P1, "2026-07-01T14:00:00Z");
        await makeSend(s2, P1, "2026-07-01T15:30:00Z"); // latest

        // P2: only an out-of-window send (> 72h before reply) → unattributed.
        const P2 = "+15556660002";
        await makeSend(s1, P2, "2026-06-25T10:00:00Z");

        // P3: already opted out before the import → must be skipped entirely.
        const P3 = "+15556660003";
        await makeSend(s2, P3, "2026-07-01T15:00:00Z");
        const c3 = (await tx.execute(sql`
          INSERT INTO contacts (org_id, phone_number)
          VALUES (${orgId}, ${P3})
          ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now()
          RETURNING id
        `)) as unknown as { id: string }[];
        await tx.execute(sql`
          INSERT INTO opt_outs (org_id, contact_id, phone_number, source)
          VALUES (${orgId}, ${c3[0].id}, ${P3}, 'pre_existing')
        `);

        // The import file. All times are ET wall-clock (16:00Z = 12:00 EDT).
        // P1 appears twice — earliest (16:00) must win over the later 17:00 row.
        const result = await importOptOutsWithAttribution(tx, {
          orgId,
          timezone: "America/New_York",
          brandIds: [brandId],
          providerIds: [],
          source: "__test_import",
          assignToGroupIds: [],
          entries: [
            { phone: P1, received_at: "2026-07-01 16:00:00" }, // 20:00Z, after s2 send
            { phone: P1, received_at: "2026-07-01 17:00:00" }, // dup, later → dropped
            { phone: P2, received_at: "2026-07-01 16:00:00" }, // unattributed
            { phone: P3, received_at: "2026-07-01 16:00:00" }, // skipped (already opted out)
          ],
        }, { validatePhone: passthroughValidate });

        check("submitted counts all file rows", result.submitted === 4, `got ${result.submitted}`);
        check("dedup collapses the duplicate P1 row", result.duplicates_in_input === 1, `got ${result.duplicates_in_input}`);
        check("P3 skipped as already opted out", result.skipped_already_opted_out === 1, `got ${result.skipped_already_opted_out}`);
        check("inserted = P1 + P2 only", result.inserted === 2, `got ${result.inserted}`);
        check("attributed = P1 only", result.attributed === 1, `got ${result.attributed}`);
        check("unattributed = P2 only", result.unattributed === 1, `got ${result.unattributed}`);
        check("affected stage is s2 (latest send)", result.affected_stages.length === 1 && result.affected_stages[0] === s2, `got ${JSON.stringify(result.affected_stages)}`);

        // P1's opt_out.created_at must be the EARLIEST reply (20:00Z), not 21:00Z.
        const p1oo = (await tx.execute(sql`
          SELECT created_at::text FROM opt_outs
          WHERE org_id = ${orgId} AND phone_number = ${P1}
        `)) as unknown as { created_at: string }[];
        check("exactly one opt_out for P1", p1oo.length === 1, `got ${p1oo.length}`);
        check(
          "P1 opt_out uses the earliest timestamp (20:00Z)",
          p1oo[0]?.created_at.startsWith("2026-07-01 20:00:00"),
          `got ${p1oo[0]?.created_at}`,
        );

        // The attribution points at s2 with brand scope applied.
        const attr = (await tx.execute(sql`
          SELECT stage_id, campaign_id FROM opt_out_attributions
          WHERE org_id = ${orgId}
            AND opt_out_id = (SELECT id FROM opt_outs WHERE org_id = ${orgId} AND phone_number = ${P1})
        `)) as unknown as { stage_id: number; campaign_id: number }[];
        check("P1 credited to s2 + campaign", attr.length === 1 && attr[0].stage_id === s2 && attr[0].campaign_id === campaignId);

        const brandScoped = (await tx.execute(sql`
          SELECT count(*)::int AS n FROM opt_out_brands ob
          JOIN opt_outs oo ON oo.id = ob.opt_out_id
          WHERE oo.org_id = ${orgId} AND oo.phone_number = ${P1} AND ob.brand_id = ${brandId}
        `)) as unknown as { n: number }[];
        check("P1 opt_out is brand-scoped", brandScoped[0].n === 1);

        // Stage counter bumped for s2.
        const s2counts = (await tx.execute(sql`
          SELECT inbound_opt_out_count, opt_out_count FROM campaign_stages WHERE id = ${s2}
        `)) as unknown as { inbound_opt_out_count: number; opt_out_count: number }[];
        check("s2 inbound_opt_out_count = 1", s2counts[0].inbound_opt_out_count === 1, `got ${s2counts[0].inbound_opt_out_count}`);
        check("s2 opt_out_count mirrored to 1", s2counts[0].opt_out_count === 1, `got ${s2counts[0].opt_out_count}`);

        // Idempotency: re-running the same import inserts nothing new and
        // re-credits nothing (P1/P2 now already opted out → all skipped).
        const rerun = await importOptOutsWithAttribution(tx, {
          orgId,
          timezone: "America/New_York",
          brandIds: [brandId],
          providerIds: [],
          source: "__test_import",
          assignToGroupIds: [],
          entries: [
            { phone: P1, received_at: "2026-07-01 16:00:00" },
            { phone: P2, received_at: "2026-07-01 16:00:00" },
          ],
        }, { validatePhone: passthroughValidate });
        check("re-run inserts 0 new opt_outs", rerun.inserted === 0, `got ${rerun.inserted}`);
        check("re-run attributes 0", rerun.attributed === 0, `got ${rerun.attributed}`);
        check("re-run skips both (already opted out)", rerun.skipped_already_opted_out === 2, `got ${rerun.skipped_already_opted_out}`);

        throw rollback;
      });
    } catch (e) {
      if (e !== rollback) throw e;
    }

    const leak = (await db.execute(sql`
      SELECT count(*)::int AS n FROM campaigns WHERE slug = '__test_import_attr'
    `)) as unknown as { n: number }[];
    check("transaction rolled back (no residue)", leak[0].n === 0);
  } finally {
    await pg.end({ timeout: 5 });
  }

  console.log(failed === 0 ? "\nAll checks passed." : `\nFAILED: ${failed} check(s).`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
