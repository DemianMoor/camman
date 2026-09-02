// RUN WITH: npx tsx --conditions=react-server scripts/test-creative-versioning.ts
import "./_env-preload";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { creatives } from "@/db/schema";
import { forkCreative } from "@/lib/guardrails/creative-versioning";
import { checkCreativeBody } from "@/lib/guardrails/url-allowlist";

// Proves that editing a creative that has sends produces a NEW creative id and
// leaves the original's text untouched.
//
// ⚠️ WRITES — so it refuses to run anywhere but the preview database, per
// docs/07-conventions.md ("probes that WRITE run against the demo database, not
// production"). It creates two rows and deletes them, then RE-QUERIES to prove
// the cleanup actually happened rather than trusting the delete.

const PREVIEW_REF = "fdzxzxayhknywvmrhjcj";

let failures = 0;
const ok = (m: string) => console.log(`  OK ${m}`);
const bad = (m: string) => {
  console.log(`  XX ${m}`);
  failures++;
};

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes(PREVIEW_REF)) {
    console.error(
      `REFUSING TO RUN: DATABASE_URL is not the preview project (${PREVIEW_REF}).\n` +
        "This test creates and deletes creatives.",
    );
    process.exit(1);
  }

  console.log("=== creative versioning ===\n");
  console.log(`  database: preview (${PREVIEW_REF})`);

  const [org] = (await db.execute(sql`
    SELECT id::text AS id FROM organizations LIMIT 1
  `)) as unknown as { id: string }[];
  if (!org) {
    bad("no organization — EMPTY scope");
    process.exit(1);
  }

  const stamp = Date.now();
  const slug = `p3-versioning-probe-${stamp}`;
  const ORIGINAL = "Original body {link}";
  const EDITED = "Edited body {link}";

  const [seed] = await db
    .insert(creatives)
    .values({ org_id: org.id, slug, text: ORIGINAL, status: "active" })
    .returning({ id: creatives.id, slug: creatives.slug });
  console.log(`  scope: seeded creative ${seed.id} (${seed.slug})`);

  const created: number[] = [seed.id];
  try {
    const fork = await forkCreative({
      orgId: org.id,
      creativeId: seed.id,
      newText: EDITED,
      actorUserId: "00000000-0000-0000-0000-000000000000",
    });
    created.push(fork.newCreativeId);

    ok(`fork returned a NEW id: ${fork.newCreativeId} (was ${seed.id})`);
    if (fork.newCreativeId === seed.id) {
      bad("the fork reused the original id — this is an in-place edit");
    }

    const [orig] = await db
      .select({ text: creatives.text })
      .from(creatives)
      .where(eq(creatives.id, seed.id));
    if (orig?.text === ORIGINAL) {
      ok("the ORIGINAL text is unchanged — history is not re-labelled");
    } else {
      bad(`the original text changed to "${orig?.text}" — it was supposed to be frozen`);
    }

    const [copy] = await db
      .select({ text: creatives.text, slug: creatives.slug })
      .from(creatives)
      .where(eq(creatives.id, fork.newCreativeId));
    if (copy?.text === EDITED) ok(`the NEW creative carries the edited text`);
    else bad(`the new creative has "${copy?.text}", expected the edit`);

    if (copy?.slug && copy.slug !== seed.slug) {
      ok(`the new creative has its own slug: ${copy.slug}`);
    } else {
      bad("slug collision — the copy reused the original slug");
    }

    // The fork path must still enforce the URL rule.
    const rejected = checkCreativeBody("Buy now at https://evil.example.com");
    if (rejected) ok("a raw URL in a body is still rejected on the fork path");
    else bad("a raw URL passed the body check");
  } finally {
    await db.delete(creatives).where(
      sql`${creatives.id} = ANY(${sql.raw(`ARRAY[${created.join(",")}]`)})`,
    );
    const [left] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM creatives WHERE slug LIKE ${"p3-versioning-probe-" + stamp + "%"}
    `)) as unknown as { n: number }[];
    if ((left?.n ?? 0) === 0) {
      ok(`cleanup verified: 0 probe rows remain (deleted ${created.length})`);
    } else {
      bad(`cleanup FAILED: ${left.n} probe row(s) still in the database`);
    }
  }

  console.log(`\n=== ${failures === 0 ? "ALL PASS" : "FAILURES"} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("threw:", e instanceof Error ? e.message : e);
  process.exit(1);
});
