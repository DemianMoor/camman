import "./_env-preload";

// READ-ONLY measurement of the lifecycle settings preview against production.
// Every run is inside a transaction that ALWAYS rolls back, so nothing is
// written; it exists to answer one question before the settings screen is
// built — how long does a preview take on the real contact base?
//
// Listed in EXCLUSIONS of scripts/test-preview-db-guard.ts: it reads production
// deliberately. Run it off the busy cron minutes (:29/:59 pools, :11/:41 fresh
// counts, :14 creative lifetime, and the */5 marks).
//
// Run: npx tsx --conditions=react-server scripts/measure-lifecycle-preview.ts

import { sql } from "drizzle-orm";

class RolledBack extends Error {
  constructor(public readonly payload: unknown) {
    super("rolled back");
  }
}

async function main() {
  const { db } = await import("@/db/client");
  const { previewLifecycleThresholds } = await import("@/lib/engagement/preview");
  const { DEFAULT_LIFECYCLE_THRESHOLDS } = await import("@/lib/engagement/constants");
  type R = Awaited<ReturnType<typeof previewLifecycleThresholds>>;

  const orgs = (await db.execute(
    sql`SELECT id FROM organizations ORDER BY created_at`,
  )) as unknown as { id: string }[];
  if (orgs.length !== 1) throw new Error(`${orgs.length} organizations — this script assumes one`);
  const orgId = orgs[0].id;
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").hostname;
  console.log(`measuring against ${host}, org ${orgId}\n`);

  const run = async (label: string, opts: Parameters<typeof previewLifecycleThresholds>[2]) => {
    let out: R | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '120s'`);
        throw new RolledBack(await previewLifecycleThresholds(tx, orgId, opts));
      });
    } catch (e) {
      if (!(e instanceof RolledBack)) throw e;
      out = e.payload as R;
    }
    console.log(
      `${label}: ${out!.durationMs} ms · evaluated ${out!.evaluated.toLocaleString()} · ` +
        `moves ${JSON.stringify(out!.transitions)}`,
    );
    return out!;
  };

  await run("1 saved values (cold)", { proposedOrg: DEFAULT_LIFECYCLE_THRESHOLDS });
  await run("2 saved values (warm)", { proposedOrg: DEFAULT_LIFECYCLE_THRESHOLDS });
  await run("3 freeze_after_messages 10 → 8", {
    proposedOrg: { ...DEFAULT_LIFECYCLE_THRESHOLDS, freeze_after_messages: 8 },
  });
  console.log("\nNothing was written (every run rolled back).");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
