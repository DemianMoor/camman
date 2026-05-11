import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface JournalFile {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

interface DbMigration extends Record<string, unknown> {
  id: number;
  hash: string;
  created_at: string;
}

interface SnapshotMeta {
  version?: string;
  dialect?: string;
  id?: string;
  prevId?: string;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");

  const journalPath = resolve(process.cwd(), "db/migrations/meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as JournalFile;

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    const rows = await db.execute<DbMigration>(drizzleSql`
      SELECT id, hash, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY id
    `);

    console.log("--- drizzle.__drizzle_migrations records ---");
    for (const r of rows) {
      const t = new Date(Number(r.created_at)).toISOString();
      console.log(`  id=${r.id}  hash=${r.hash.slice(0, 16)}…  created=${t}`);
    }

    console.log(`\n--- _journal.json entries (${journal.entries.length}) ---`);
    for (const e of journal.entries) {
      const t = new Date(e.when).toISOString();
      console.log(`  idx=${e.idx}  tag=${e.tag}  when=${t}`);
    }

    console.log("\n--- Per-migration cross-check ---");
    let issues = 0;

    if (rows.length !== journal.entries.length) {
      console.log(
        `  ✗ Record count mismatch: DB has ${rows.length}, journal has ${journal.entries.length}`,
      );
      issues++;
    } else {
      console.log(`  ✓ Record counts match (${rows.length})`);
    }

    for (const entry of journal.entries) {
      const sqlPath = resolve(
        process.cwd(),
        `db/migrations/${entry.tag}.sql`,
      );
      const snapshotPath = resolve(
        process.cwd(),
        `db/migrations/meta/${entry.tag.split("_")[0]}_snapshot.json`,
      );

      const sqlExists = existsSync(sqlPath);
      const snapshotExists = existsSync(snapshotPath);

      if (!sqlExists) {
        console.log(`  ✗ ${entry.tag}: SQL file missing (${sqlPath})`);
        issues++;
        continue;
      }
      if (!snapshotExists) {
        console.log(`  ✗ ${entry.tag}: snapshot missing (${snapshotPath})`);
        issues++;
        continue;
      }

      const sqlContent = readFileSync(sqlPath, "utf8");
      // Drizzle hashes the migration SQL content. We compute SHA-256 here as a
      // sanity check against the recorded hash.
      const computedHash = createHash("sha256").update(sqlContent).digest("hex");
      const recordHash = rows[entry.idx]?.hash;
      const hashMatches = recordHash === computedHash;

      const snapshot = JSON.parse(
        readFileSync(snapshotPath, "utf8"),
      ) as SnapshotMeta;

      const previousSnapshotPath =
        entry.idx > 0
          ? resolve(
              process.cwd(),
              `db/migrations/meta/${journal.entries[entry.idx - 1].tag.split("_")[0]}_snapshot.json`,
            )
          : null;
      const expectedPrevId = previousSnapshotPath
        ? (
            JSON.parse(
              readFileSync(previousSnapshotPath, "utf8"),
            ) as SnapshotMeta
          ).id
        : undefined;
      const prevIdMatches =
        entry.idx === 0 || snapshot.prevId === expectedPrevId;

      console.log(
        `  ${entry.tag}: ` +
          `SQL ${sqlExists ? "✓" : "✗"}, ` +
          `snapshot ${snapshotExists ? "✓" : "✗"}, ` +
          `hash ${hashMatches ? "✓" : "✗"}, ` +
          `prevId-chain ${prevIdMatches ? "✓" : "✗"}`,
      );

      if (!hashMatches) {
        console.log(
          `      recorded: ${recordHash?.slice(0, 16)}…  computed: ${computedHash.slice(0, 16)}…`,
        );
        issues++;
      }
      if (!prevIdMatches) {
        console.log(
          `      prevId in snapshot: ${snapshot.prevId}, expected: ${expectedPrevId}`,
        );
        issues++;
      }
    }

    console.log(
      issues === 0
        ? "\nMigration integrity OK."
        : `\nFAILED: ${issues} issue(s) found.`,
    );
    if (issues > 0) process.exit(1);
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Verification crashed:", err);
  process.exit(1);
});
