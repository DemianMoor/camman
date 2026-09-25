import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// THE SWITCH (PR 4c Task 6) against the PREVIEW DB: a new campaign becomes a
// LIFECYCLE campaign only while the engagement engine is actually writing.
//
// ⭐ Why the gate exists: the statuses the chips select on are maintained by
// the engagement job. With engine_mode = 'off' they are frozen at whenever the
// job stopped, so a campaign picking "Hot" would target whoever was hot that
// day rather than whoever is hot now — silently, and more wrongly the longer
// the engine stays off.
//
// ⭐ Why BOTH directions are asserted: a one-sided test ("engine off ⇒ legacy")
// passes just as happily on a function that always falls back, which would
// mean the feature could never turn on at all.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-lifecycle-switch.ts

import { sql, type SQL } from "drizzle-orm";

const MARKER = "__LIFECYCLE_SWITCH_TEST__";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { db } = await import("@/db/client");
  const { loadLifecycleSettings } =
    await import("@/lib/engagement/settings-io");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T>(q: SQL): Promise<T> =>
    ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> =>
    (await db.execute(q)) as unknown as T[];

  const tag = `switch-${Date.now()}`;
  let orgId = "";

  try {
    orgId = (
      await one<{ id: string }>(
        sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`,
      )
    ).id;
    const org = sql`${orgId}::uuid`;

    console.log("PART K — the lifecycle_rules switch");

    // The route's decision, reproduced through the SAME reader it uses, then
    // the same insert + audit shape. Not a copy of the predicate: the point is
    // that loadLifecycleSettings is the one source of the engine's posture.
    const createCampaign = async (label: string) => {
      return db.transaction(async (tx) => {
        const settings = await loadLifecycleSettings(tx, orgId);
        const lifecycleRules = settings.engine_mode === "write";
        const [row] = (await tx.execute(sql`
          INSERT INTO campaigns (org_id, slug, name, status, link_mode, lifecycle_rules)
          VALUES (${org}, ${`${label}-${tag}`}, ${label}, 'draft', 'manual', ${lifecycleRules})
          RETURNING id, lifecycle_rules
        `)) as unknown as { id: number; lifecycle_rules: boolean }[];
        if (!lifecycleRules) {
          await tx.execute(sql`
            INSERT INTO org_setting_events
              (org_id, setting_key, old_value, new_value, actor_user_id)
            VALUES (${org}, 'lifecycle.campaign_fallback', ${settings.engine_mode},
                    ${`campaign:${row.id} created with lifecycle_rules=false`}, NULL)
          `);
        }
        return row;
      });
    };
    const auditRows = async () =>
      all<{ old_value: string; new_value: string }>(sql`
        SELECT old_value, new_value FROM org_setting_events
        WHERE org_id = ${org} AND setting_key = 'lifecycle.campaign_fallback'
        ORDER BY id`);

    // ── engine OFF (no settings row at all — the shipped default) ──────────
    const offCampaign = await createCampaign("engine-off");
    bar(
      "K1 with NO settings row, a new campaign is LEGACY",
      offCampaign.lifecycle_rules === false,
      `lifecycle_rules=${offCampaign.lifecycle_rules}`,
    );
    let audit = await auditRows();
    bar(
      "K2 …and the fallback is AUDITED, naming the engine it saw",
      audit.length === 1 &&
        audit[0].old_value === "off" &&
        audit[0].new_value.includes(`campaign:${offCampaign.id}`),
      audit[0]
        ? `${audit[0].old_value} → ${audit[0].new_value}`
        : "(no audit row)",
    );

    // ── engine explicitly 'off' ───────────────────────────────────────────
    await db.execute(sql`
      INSERT INTO lifecycle_settings (org_id, engine_mode) VALUES (${org}, 'off')
      ON CONFLICT (org_id) DO UPDATE SET engine_mode = 'off'`);
    const off2 = await createCampaign("engine-off-explicit");
    bar(
      "K3 with engine_mode = 'off', a new campaign is LEGACY",
      off2.lifecycle_rules === false,
      `lifecycle_rules=${off2.lifecycle_rules}`,
    );
    bar(
      "K4 …and it is audited too (one row per fallback, not one per create)",
      (await auditRows()).length === 2,
      `${(await auditRows()).length} audit row(s)`,
    );

    // ── engine ON ─────────────────────────────────────────────────────────
    // ⭐ The other direction. Without this, everything above passes on a
    // function that can only ever return false.
    await db.execute(sql`
      UPDATE lifecycle_settings SET engine_mode = 'write' WHERE org_id = ${org}`);
    const onCampaign = await createCampaign("engine-write");
    bar(
      "K5 ⭐ with engine_mode = 'write', a new campaign IS a lifecycle campaign",
      onCampaign.lifecycle_rules === true,
      `lifecycle_rules=${onCampaign.lifecycle_rules}`,
    );
    audit = await auditRows();
    bar(
      "K6 ⭐ …and NOTHING is audited — the table lists exceptions, not creates",
      audit.length === 2,
      `still ${audit.length} audit row(s)`,
    );

    // ── the flag is decided per create, not inherited ─────────────────────
    await db.execute(sql`
      UPDATE lifecycle_settings SET engine_mode = 'off' WHERE org_id = ${org}`);
    const afterOff = await createCampaign("engine-off-again");
    bar(
      "K7 the engine is re-read on EVERY create, not cached from the last one",
      afterOff.lifecycle_rules === false && (await auditRows()).length === 3,
      `lifecycle_rules=${afterOff.lifecycle_rules}, ${(await auditRows()).length} audit row(s)`,
    );

    // ── existing campaigns are never touched ──────────────────────────────
    const stillOn = await one<{ lifecycle_rules: boolean }>(
      sql`SELECT lifecycle_rules FROM campaigns WHERE id = ${onCampaign.id}`,
    );
    bar(
      "K8 an EXISTING campaign's flag is not rewritten when the engine flips",
      stillOn.lifecycle_rules === true,
      "its audience recipe was chosen under lifecycle semantics and stays that way",
    );
    // ── K9: does the ROUTE actually do this? ──────────────────────────────
    // ⭐ Everything above exercises a REPRODUCTION of the route's decision, so
    // on its own it would pass happily after someone removed the gate from the
    // route entirely. A behaviour test of a copy proves the copy works. This
    // reads the route's source and asserts the three things that make the gate
    // real — the same discipline as "a guard nothing calls is not a guard".
    const { readFileSync } = await import("node:fs");
    const routeSrc = readFileSync("app/api/campaigns/route.ts", "utf-8");
    const txStart = routeSrc.indexOf("db.transaction(async (tx)");
    const readsInTx =
      txStart >= 0 &&
      routeSrc.indexOf("loadLifecycleSettings(tx", txStart) > txStart;
    bar(
      "K9 ⭐ the route reads the engine INSIDE its transaction",
      readsInTx,
      readsInTx
        ? "loadLifecycleSettings(tx, …)"
        : "NOT FOUND — a read outside the tx can disagree with the insert",
    );
    bar(
      "K10 the route names lifecycle_rules in values() explicitly",
      /lifecycle_rules:\s*lifecycleRules/.test(routeSrc),
      "an unnamed field silently takes the column default",
    );
    bar(
      "K11 the route writes the fallback audit under the expected key",
      routeSrc.includes("lifecycle.campaign_fallback") &&
        routeSrc.includes("org_setting_events"),
      "'lifecycle.campaign_fallback' into org_setting_events",
    );
  } finally {
    if (orgId) {
      const name =
        (
          await all<{ name: string }>(
            sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`,
          )
        )[0]?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(
          `REFUSING TEARDOWN: org ${orgId} lacks the marker (${JSON.stringify(name)})`,
        );
        fail++;
      } else {
        await db.execute(
          sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`,
        );
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM org_setting_events WHERE org_id = ${orgId}::uuid)
              + (SELECT count(*) FROM lifecycle_settings WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left`);
      if (Number(left.n) !== 0) fail++;
    }
  }

  console.log(
    fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
