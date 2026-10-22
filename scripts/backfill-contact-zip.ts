// scripts/backfill-contact-zip.ts — fill contact_attributes.zip (0219) from
// lead_inbox.raw for contacts whose zip is still NULL. Core: lib/drip/zip-backfill.ts.
//
// ⚠️ Targets whatever DATABASE_URL holds (.env.local = PRODUCTION). Owner-gated:
// run on prod only after the owner's go, off-hours (it reads lead_inbox.raw,
// ~300 MB). Dry run is the DEFAULT and runs inside READ ONLY transactions;
// --apply writes, one committed transaction per batch, only rows still NULL
// (idempotent, re-runnable, never overwrites a known zip).
//
//   npx tsx --conditions=react-server scripts/backfill-contact-zip.ts            # dry run
//   npx tsx --conditions=react-server scripts/backfill-contact-zip.ts --apply
//   … [--org <uuid>] [--batch 5000]
import "./_env-preload";
import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import { TAGS } from "@/lib/messages/tags";
import { applyZipBackfill, planZipBackfill, withDeadlockRetry } from "@/lib/drip/zip-backfill";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ORG = arg("--org") ?? null;
const BATCH = Number(arg("--batch") ?? 5000);
class ReadOnlyDone extends Error {}

async function hasZipColumn(): Promise<boolean> {
  const r = (await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contact_attributes' AND column_name = 'zip'`)) as unknown as unknown[];
  return r.length > 0;
}

async function counts(withZip: boolean) {
  const r = (await db.execute(sql`
    SELECT count(*)::int AS attrs, ${withZip ? sql`count(zip)::int` : sql`0`} AS with_zip
    FROM contact_attributes WHERE (${ORG}::uuid IS NULL OR org_id = ${ORG}::uuid)`)) as unknown as { attrs: number; with_zip: number }[];
  return r[0];
}

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x");
  console.log(`DB ${host.username.split(".").pop()} · ${APPLY ? "APPLY" : "DRY RUN (read-only)"} · batch ${BATCH}${ORG ? ` · org ${ORG}` : ""}`);
  // Before 0219 the column does not exist: a dry run still measures what the
  // backfill WOULD write (every contact counts as zip-less); --apply refuses.
  const zipCol = await hasZipColumn();
  if (!zipCol) {
    if (APPLY) {
      console.error("contact_attributes.zip does not exist — apply migration 0219 first.");
      process.exitCode = 2;
      return;
    }
    console.log("note: contact_attributes.zip does not exist yet (pre-0219) — every contact counts as zip-less");
  }
  const before = await counts(zipCol);
  console.log(`before: ${before.attrs.toLocaleString()} attribute rows, ${before.with_zip.toLocaleString()} with zip`);

  let cursor: string | null = null;
  let scanned = 0, candidates = 0, fiveDigit = 0, written = 0, pages = 0;
  const byPartner = new Map<string, number>();
  const t0 = Date.now();
  for (;;) {
    let page: Awaited<ReturnType<typeof planZipBackfill>> | undefined;
    if (APPLY) {
      // A page that loses a deadlock to live enrichment is retried (idempotent).
      const res = await withDeadlockRetry(() =>
        db.transaction(async (tx) => {
          const pg = await planZipBackfill(tx, { orgId: ORG, afterContactId: cursor, limit: BATCH, hasZipColumn: true });
          return { pg, w: await applyZipBackfill(tx, pg.candidates) };
        }),
      );
      page = res.pg;
      written += res.w;
    } else {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET TRANSACTION READ ONLY`);
          page = await planZipBackfill(tx, { orgId: ORG, afterContactId: cursor, limit: BATCH, hasZipColumn: zipCol });
          throw new ReadOnlyDone();
        });
      } catch (e) {
        if (!(e instanceof ReadOnlyDone)) throw e;
      }
    }
    const p = page!;
    pages++;
    scanned += p.scanned;
    candidates += p.candidates.length;
    for (const c of p.candidates) {
      if (TAGS.zip.normalize(c.zip) !== null) fiveDigit++;
      byPartner.set(c.partnerSlug ?? "(none)", (byPartner.get(c.partnerSlug ?? "(none)") ?? 0) + 1);
    }
    if (p.scanned < BATCH || p.lastContactId === null) break;
    cursor = p.lastContactId;
  }

  console.log(`scanned ${scanned.toLocaleString()} zip-less contacts in ${pages} page(s), ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`${APPLY ? "updated" : "would update"}: ${(APPLY ? written : candidates).toLocaleString()}`);
  console.log(`  of which a valid {zip} (5 digits / ZIP+4): ${fiveDigit.toLocaleString()} (${candidates ? ((100 * fiveDigit) / candidates).toFixed(2) : "0.00"}%)`);
  console.log(`  by partner: ${JSON.stringify(Object.fromEntries([...byPartner].sort((a, b) => b[1] - a[1])))}`);
  const after = await counts(zipCol);
  console.log(`after: ${after.with_zip.toLocaleString()} with zip${APPLY ? "" : " (unchanged — dry run)"}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pgConn.end({ timeout: 5 }));
