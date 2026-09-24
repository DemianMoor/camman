import "./_env-preload";

// PRODUCTION TOOL — contact engagement (migration 0187): the dry-run report and
// the one-off backfill. Listed in scripts/test-preview-db-guard.ts EXCLUSIONS.
//
//   default   DRY RUN. The full refresh inside a transaction that is ALWAYS
//             rolled back (and with dryRun = true, so no write statement even
//             runs). Prints: status counts org-wide, opted-out per status,
//             freeze contacts not due today, the same counts per active contact
//             group, the transitions and rows it would write, and phase timings.
//             --out <file.json> also writes the raw result.
//   --apply   THE BACKFILL, in ONE transaction: the full refresh with reason
//             'backfill', both job heartbeats, lifecycle_settings.engine_mode =
//             'write' and an org_setting_events audit row. It refuses if the org
//             already has contact_engagement rows. This is a data write: it
//             needs the owner's explicit approval of the dry-run numbers first.
//
// Run: npx tsx --conditions=react-server scripts/engagement-backfill.ts [--org <uuid>] [--out <file>] [--apply]
// Without --org the database must hold exactly one organization.

import { writeFileSync } from "node:fs";

import { sql } from "drizzle-orm";

class RolledBack extends Error {
  constructor(public readonly payload: unknown) {
    super("dry run — rolled back");
  }
}

async function main() {
  const { db } = await import("@/db/client");
  const { refreshContactEngagement } = await import("@/lib/engagement/refresh");
  const { recordHeartbeat } = await import("@/lib/reporting/cron-heartbeat");
  const { ENGAGEMENT_FULL_JOB, ENGAGEMENT_JOB, ENGAGEMENT_STATUSES } = await import(
    "@/lib/engagement/constants"
  );
  type Result = Awaited<ReturnType<typeof refreshContactEngagement>>;

  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const arg = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let orgId = arg("--org");
  if (!orgId) {
    const orgs = (await db.execute(
      sql`SELECT id FROM organizations ORDER BY created_at`,
    )) as unknown as { id: string }[];
    if (orgs.length !== 1) throw new Error(`${orgs.length} organizations — pass --org <uuid>`);
    orgId = orgs[0].id;
  }
  const host = new URL(process.env.DATABASE_URL ?? "postgres://x@unknown/x").hostname;
  console.log(`${apply ? "APPLY" : "DRY RUN"} — org ${orgId} — db host ${host}\n`);

  const pad = (s: string | number, n: number) => String(s).padStart(n);
  const print = (r: Result) => {
    console.log("status        contacts   of which opted out");
    for (const s of ENGAGEMENT_STATUSES) {
      console.log(`${s.padEnd(12)} ${pad(r.statusCounts[s], 9)}   ${pad(r.optedOutByStatus?.[s] ?? 0, 9)}`);
    }
    console.log(`\nfreeze contacts NOT due today (last message inside their cadence): ${r.freezeNotDue}`);
    console.log("\nper active contact group (fan-out: a contact in several groups counts in each)");
    console.log(`${"group".padEnd(34)}${ENGAGEMENT_STATUSES.map((s) => pad(s, 11)).join("")}`);
    for (const g of r.groups ?? []) {
      console.log(
        `${`${g.group_id} ${g.name}`.slice(0, 33).padEnd(34)}` +
          ENGAGEMENT_STATUSES.map((s) => pad(g.counts[s], 11)).join(""),
      );
    }
    console.log(`\ntransitions: ${JSON.stringify(r.transitions)}`);
    console.log(
      `rows ${r.dryRun ? "that would be " : ""}written: contact_engagement ${r.rowsWritten}, ` +
        `transitions ${r.transitionsWritten}, contacts.lifecycle_status ${r.projectionWritten}, ` +
        `contact_offer_campaigns ${r.offerRowsWritten} ` +
        `(+${r.offerRowsDeleted} deleted)`,
    );
    console.log(`evaluated ${r.evaluated}, recounted ${r.recounted}`);
    console.log(`timing (ms): ${JSON.stringify(r.phaseMs)}  total ${r.durationMs}`);
  };

  if (!apply) {
    let result: Result | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '600s'`);
        const r = await refreshContactEngagement(tx, orgId!, {
          mode: "full",
          dryRun: true,
          initialReason: "backfill",
          withReport: true,
        });
        throw new RolledBack(r);
      });
    } catch (err) {
      if (!(err instanceof RolledBack)) throw err;
      result = err.payload as Result;
    }
    print(result!);
    const out = arg("--out");
    if (out) {
      writeFileSync(out, JSON.stringify(result, null, 2));
      console.log(`\nraw result written to ${out}`);
    }
    console.log("\nDRY RUN — nothing was written (transaction rolled back).");
    return;
  }

  const existing = (await db.execute(sql`
    SELECT count(*)::int AS n FROM contact_engagement WHERE org_id = ${orgId}::uuid
  `)) as unknown as { n: number }[];
  if (Number(existing[0].n) > 0) {
    throw new Error(
      `REFUSING: org already has ${existing[0].n} contact_engagement rows — the backfill is one-off.`,
    );
  }
  const r = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '1200s'`);
    const res = await refreshContactEngagement(tx, orgId!, {
      mode: "full",
      dryRun: false,
      initialReason: "backfill",
      withReport: true,
    });
    const prev = (await tx.execute(sql`
      SELECT engine_mode FROM lifecycle_settings WHERE org_id = ${orgId}::uuid
    `)) as unknown as { engine_mode: string }[];
    await tx.execute(sql`
      INSERT INTO lifecycle_settings (org_id, engine_mode, updated_at)
      VALUES (${orgId}::uuid, 'write', now())
      ON CONFLICT (org_id) DO UPDATE SET engine_mode = 'write', updated_at = now()
    `);
    await tx.execute(sql`
      INSERT INTO org_setting_events (org_id, setting_key, old_value, new_value, actor_user_id)
      VALUES (${orgId}::uuid, 'lifecycle.engine_mode', ${prev[0]?.engine_mode ?? "off"}, 'write', NULL)
    `);
    // Stamp both heartbeats so the watchers do not read a just-enabled engine as
    // a dead job, and so the first cron tick runs incrementally from here.
    await recordHeartbeat(tx, ENGAGEMENT_JOB);
    await recordHeartbeat(tx, ENGAGEMENT_FULL_JOB);
    return res;
  });
  print(r);
  console.log("\nAPPLIED — engine_mode = 'write'; the 15-min cron takes over from here.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
