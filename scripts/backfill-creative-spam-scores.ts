// One-time backfill: copy cached spam scores (from spam_scores) onto the
// corresponding creatives row column. Run after the auto-score-on-save
// feature was added (migration 0034) for creatives that existed BEFORE
// auto-scoring landed and therefore have NULL spam_score on the row even
// though the cache holds a matching hash.
//
// Read-only on rows that already have a row-level score; only fills NULLs.
// Idempotent — re-running is a no-op once everything is backfilled.
//
// Run: npx tsx scripts/backfill-creative-spam-scores.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { and, eq, isNull, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { creatives, spam_scores } from "@/db/schema";
import { hashText } from "@/lib/spam/normalize";
import { deriveVerdict } from "@/lib/spam/types";

const PROVIDER =
  (process.env.SPAM_PROVIDER ?? "classifier") === "classifier"
    ? "classifier-v1"
    : (process.env.SPAM_PROVIDER ?? "classifier");

async function main() {
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);
  try {
    const unscored = await db
      .select({
        id: creatives.id,
        org_id: creatives.org_id,
        text: creatives.text,
      })
      .from(creatives)
      .where(isNull(creatives.spam_score));
    console.log(`Found ${unscored.length} creatives without row-level spam_score.`);

    let filled = 0;
    let missed = 0;
    for (const c of unscored) {
      const text_hash = hashText(c.text);
      const hit = await db
        .select({ score: spam_scores.score })
        .from(spam_scores)
        .where(
          and(
            eq(spam_scores.org_id, c.org_id),
            eq(spam_scores.provider, PROVIDER),
            eq(spam_scores.text_hash, text_hash),
          ),
        )
        .limit(1);
      if (!hit[0]) {
        missed++;
        continue;
      }
      const score = hit[0].score;
      const binaryLabel: "ham" | "spam" =
        deriveVerdict(score) === "spam" ? "spam" : "ham";
      await db
        .update(creatives)
        .set({
          spam_score: score,
          spam_label: binaryLabel,
          spam_scored_at: drizzleSql`now()`,
          spam_model_id: PROVIDER,
          spam_score_error: null,
        })
        .where(
          and(eq(creatives.id, c.id), eq(creatives.org_id, c.org_id)),
        );
      filled++;
    }
    console.log(`Filled: ${filled}, no cache hit: ${missed}`);
  } finally {
    await pg.end({ timeout: 1 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
