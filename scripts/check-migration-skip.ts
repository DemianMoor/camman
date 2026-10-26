import "./_env-preload";

// APPLY-TIME SKIP PREFLIGHT — runs before every `npm run db:migrate` (package.json),
// on prod and on the preview DB alike. Read-only.
//
// Refuses (exit 1) when any migration in this checkout's journal is NOT applied
// on the target DB and has a `when` at or below the newest one the DB already
// applied. Drizzle would skip it silently, forever (scripts/_migration-skip.ts).
//
// Why this exists alongside test-migration-numbering-guard (CI): that guard
// compares a branch against origin/main's JOURNAL, but migrations reach prod in
// the morning window BEFORE their PR merges, so prod can be ahead of main. Two
// unmerged branches (0225 and 0226, 2026-10-26) were each valid against main
// while one would have been skipped had the other been applied first. Only the
// target database knows what it has applied, so the check runs against it, at
// the moment of applying.
//
// Fix when it fires: give the skipped migration the next free number and a
// `when` above the newest applied (owner rule 2026-10-26, docs/07-conventions.md).
//
// Run: npx tsx scripts/check-migration-skip.ts

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { ACCEPTED_DRIFT, projectRefOf, skipReport, type AppliedRow, type JournalEntry } from "./_migration-skip";
import { withReadOnlyDb } from "./_readonly-db";

const DIR = "db/migrations";

async function main() {
  const journal = (JSON.parse(readFileSync(`${DIR}/meta/_journal.json`, "utf8")) as { entries: JournalEntry[] }).entries;
  const applied = await withReadOnlyDb(
    async (tx) =>
      (await tx`SELECT created_at::bigint AS created_at, hash FROM drizzle.__drizzle_migrations`) as unknown as AppliedRow[],
  );
  const hashOf = (tag: string) => createHash("sha256").update(readFileSync(`${DIR}/${tag}.sql`).toString()).digest("hex");
  const ref = projectRefOf(process.env.DATABASE_URL ?? "");
  const accepted = ACCEPTED_DRIFT[ref ?? ""] ?? {};
  const r = skipReport(journal, applied, hashOf, new Set(Object.keys(accepted)));

  console.log(
    `[migration-skip] db ${ref ?? "?"} · newest applied when=${r.newestApplied} · pending: ${r.pending.map((e) => e.tag).join(", ") || "none"}`,
  );
  for (const e of r.accepted) console.log(`[migration-skip] accepted drift ${e.tag}: ${accepted[e.tag]}`);
  if (r.skipped.length > 0) {
    console.error(
      `[migration-skip] REFUSING: ${r.skipped.map((e) => `${e.tag} (when ${e.when})`).join(", ")} ` +
        `is not applied and is not newer than the newest applied migration (${r.newestApplied}). ` +
        `Drizzle would skip it silently. Renumber it and set its journal \`when\` above ${r.newestApplied}.`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
