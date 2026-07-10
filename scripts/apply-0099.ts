// Controlled apply of migration 0099 (carrier_norm Unidentified/Unknown split).
// Precondition: phone_lookups must be EMPTY (else the blanket 'Unknown'->'Unidentified'
// flip would wrongly reclassify legitimately looked-up-undetermined contacts). The
// flip runs in 50k batches so the 752k-row contacts table is never held under one
// long lock. Idempotent + safe to re-run. Run `npm run db:migrate` AFTER (the
// migration's guarded statements then no-op), then verify-migration-integrity.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import postgres from "postgres";

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    await pg.unsafe(`SET lock_timeout = '5s'`);

    // Precondition.
    const [{ n }] = await pg<{ n: string }[]>`SELECT count(*)::text AS n FROM phone_lookups`;
    if (n !== "0") {
      throw new Error(
        `precondition failed: phone_lookups has ${n} rows — the blanket flip is only safe while empty. Aborting.`,
      );
    }
    console.log("precondition ok: phone_lookups is empty\n");

    await withRetry(pg, `ALTER TABLE public.contacts ALTER COLUMN carrier_norm SET DEFAULT 'Unidentified'`);
    await withRetry(
      pg,
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_carrier_norm_check') THEN
           ALTER TABLE public.contacts ADD CONSTRAINT contacts_carrier_norm_check
             CHECK (carrier_norm IN ('AT&T','T-Mobile','Verizon','Other Mobile','VoIP','Unknown','Unmapped','Unidentified'));
         END IF;
       END $$`,
    );

    console.log("\nbatched flip 'Unknown' -> 'Unidentified' (50k/batch):");
    let total = 0;
    for (;;) {
      const rows = await pg.unsafe(`
        WITH b AS (
          SELECT ctid FROM public.contacts WHERE carrier_norm = 'Unknown'
          LIMIT 50000 FOR UPDATE SKIP LOCKED
        )
        UPDATE public.contacts c SET carrier_norm = 'Unidentified'
        FROM b WHERE c.ctid = b.ctid`);
      const affected = rows.count ?? 0;
      total += affected;
      if (affected === 0) break;
      console.log(`  +${affected} (total ${total})`);
    }
    console.log(`flipped ${total} rows`);

    const dist = await pg<{ carrier_norm: string; n: string }[]>`
      SELECT carrier_norm, count(*)::text AS n FROM contacts GROUP BY 1 ORDER BY 2 DESC`;
    console.log("\ncontacts.carrier_norm distribution now:");
    for (const r of dist) console.log(`  ${r.carrier_norm.padEnd(14)} ${r.n}`);
    console.log("\nDDL + flip done. Next: `npm run db:migrate` then verify-migration-integrity.");
  } finally {
    await pg.end({ timeout: 5 });
  }
}

async function withRetry(pg: postgres.Sql, stmt: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pg.unsafe(stmt);
      console.log(`  ✓ ${stmt.split("\n")[0].slice(0, 70)}`);
      return;
    } catch (e) {
      if ((e as { code?: string }).code === "55P03" && attempt < 5) {
        console.log(`  ↻ lock busy, retry ${attempt}/5`);
        continue;
      }
      throw e;
    }
  }
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
