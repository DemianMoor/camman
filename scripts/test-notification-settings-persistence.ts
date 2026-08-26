import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import {
  loadNotificationSettings,
  saveNotificationSettings,
} from "@/lib/reporting/notification-settings";
import { DEFAULT_NOTIFICATION_SETTINGS } from "@/lib/reporting/telegram-report-format";

// Persistence probe for notification_settings (migration 0173).
//
// ⭐ WHY THIS EXISTS. The settings page is the only writer, `active_weekdays`
// is the only smallint[] on the write path, and the first version of the route
// interpolated that array into a Drizzle `sql` template. Drizzle FLATTENS a JS
// array into positional params there, so the statement went out with eight
// params for three placeholders and Postgres rejected it with 42804 ("column
// is of type smallint[] but expression is of type integer"). `tsc`, `eslint`
// and `next build` were all green while that was true — nothing short of
// executing the statement finds it. So this executes it, through the REAL
// exported function the route calls, not a re-typed copy of the query.
//
// Everything runs inside a transaction that is unconditionally rolled back, so
// it is safe against production and leaves no row behind.

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  const orgs = (await db.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as { id: string }[];
  const orgId = orgs[0]?.id;
  if (!orgId) throw new Error("no organization to probe with");

  const before = (await db.execute(sql`SELECT count(*)::int AS n FROM notification_settings`)) as unknown as { n: number }[];
  const rowsBefore = before[0]?.n ?? 0;

  try {
    await db.transaction(async (tx) => {
      const exec = tx as unknown as Parameters<typeof saveNotificationSettings>[2];

      // No row yet → the defaults, and they must be the inert ones.
      const empty = await loadNotificationSettings(orgId, exec);
      check("no row → defaults", empty.updated_at === null);
      check("default window wraps midnight (16 → 1)", empty.hourly_window_from === 16 && empty.hourly_window_to === 1, `${empty.hourly_window_from}→${empty.hourly_window_to}`);
      check("default weekdays exclude Sunday", JSON.stringify(empty.active_weekdays) === "[1,2,3,4,5,6]", JSON.stringify(empty.active_weekdays));

      // The write that used to throw 42804.
      const weekdays = [1, 3, 5, 7];
      await saveNotificationSettings(orgId, { active_weekdays: weekdays, hourly_interval_hours: 2 }, exec);
      const saved = await loadNotificationSettings(orgId, exec);
      check("smallint[] round-trips through the real save path", JSON.stringify(saved.active_weekdays) === JSON.stringify(weekdays), JSON.stringify(saved.active_weekdays));
      check("scalar alongside the array is not shifted", saved.hourly_interval_hours === 2, String(saved.hourly_interval_hours));
      check("unpatched fields keep their defaults", saved.daily_report_hour === DEFAULT_NOTIFICATION_SETTINGS.daily_report_hour && saved.hourly_window_to === DEFAULT_NOTIFICATION_SETTINGS.hourly_window_to);
      check("updated_at stamped on write", saved.updated_at !== null);

      // Second save must UPDATE, not duplicate or fail on the PK.
      await saveNotificationSettings(orgId, { active_weekdays: [2, 4] }, exec);
      const again = await loadNotificationSettings(orgId, exec);
      check("re-save updates in place", JSON.stringify(again.active_weekdays) === "[2,4]", JSON.stringify(again.active_weekdays));
      check("re-save preserves the earlier patch", again.hourly_interval_hours === 2);
      const n = (await tx.execute(sql`SELECT count(*)::int AS n FROM notification_settings WHERE org_id = ${orgId}`)) as unknown as { n: number }[];
      check("still exactly one row for the org", n[0]?.n === 1, `${n[0]?.n} rows`);

      // The CHECK constraint must reject a weekday outside 1..7.
      let rejected = false;
      await tx.execute(sql`SAVEPOINT weekday_probe`);
      try {
        await tx.execute(sql`UPDATE notification_settings SET active_weekdays = ARRAY[0,9]::smallint[] WHERE org_id = ${orgId}`);
      } catch {
        rejected = true;
      }
      await tx.execute(rejected ? sql`ROLLBACK TO SAVEPOINT weekday_probe` : sql`RELEASE SAVEPOINT weekday_probe`);
      check("CHECK rejects weekdays outside 1..7", rejected);

      throw new Error("__rollback__");
    });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__rollback__") throw e;
  }

  const after = (await db.execute(sql`SELECT count(*)::int AS n FROM notification_settings`)) as unknown as { n: number }[];
  check("rolled back — no residue", (after[0]?.n ?? 0) === rowsBefore, `${rowsBefore} → ${after[0]?.n}`);

  await pgConn.end();
  console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pgConn.end().catch(() => {});
  process.exit(1);
});
