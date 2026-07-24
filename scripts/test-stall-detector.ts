// Phase 3 verification: findStalledStages flags a stage that should be draining
// but has made no send progress, and does NOT flag healthy / legitimately-held
// stages (recent sends, out of window, provider paused, not yet materialized).
//
// Rolled-back tx, throwaway org. Read-only detector — no sends. Time is injected
// (`now`) so the "N minutes ago" thresholds are deterministic.
//
// Run: npx tsx scripts/test-stall-detector.ts
import "./_env-preload";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { findStalledStages } from "@/lib/sends/stall-detector";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

// Weekday-noon-ET "now". Provider windows are all-day (0..1439) unless a case
// overrides, so in-window is the default.
const NOW = new Date("2026-06-15T16:00:00Z");
const iso = (minsAgo: number) => new Date(NOW.getTime() - minsAgo * 60_000).toISOString();

const ROLLBACK = Symbol("rollback");

async function main() {
  let n = 0;
  const uniq = () => `${Date.now()}-${n++}`;
  let pnSeq = 2_000_000;
  const mkNumber = () => `+1556${pnSeq++}`;

  try {
    await db.transaction(async (tx) => {
      const dbc = tx as unknown as typeof db;
      const one = async <T>(q: ReturnType<typeof sql>) =>
        ((await tx.execute(q)) as unknown as T[])[0];

      const org = await one<{ id: string }>(sql`
        INSERT INTO organizations (name) VALUES (${`sd-${uniq()}`}) RETURNING id
      `);
      const orgId = org.id;
      await tx.execute(sql`
        INSERT INTO org_settings (org_id, sends_enabled) VALUES (${orgId}, true)
        ON CONFLICT (org_id) DO UPDATE SET sends_enabled = true
      `);
      const brand = await one<{ id: number }>(sql`
        INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${`b-${uniq()}`}, ${"B"}) RETURNING id
      `);
      const camp = await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, brand_id, link_mode, status)
        VALUES (${orgId}, ${`c-${uniq()}`}, ${brand.id}, 'tracked', 'active') RETURNING id
      `);

      const mkProvider = async (allDayWindow = true, paused = false) =>
        (await one<{ id: number }>(sql`
          INSERT INTO sms_providers
            (sms_provider_id, org_id, name, supports_api_send, status, send_paused,
             send_window_weekday_start, send_window_weekday_end,
             send_window_weekend_start, send_window_weekend_end)
          VALUES (${`p-${uniq()}`}, ${orgId}, ${"P"}, true, 'active', ${paused},
                  ${allDayWindow ? 0 : 600}, ${allDayWindow ? 1439 : 601},
                  ${allDayWindow ? 0 : 600}, ${allDayWindow ? 1439 : 601})
          RETURNING id
        `)).id;
      const mkPhone = async (providerId: number) =>
        (await one<{ id: number }>(sql`
          INSERT INTO provider_phones (org_id, provider_id, phone_number, max_sends_per_second)
          VALUES (${orgId}, ${providerId}, ${mkNumber()}, 60) RETURNING id
        `)).id;

      let stageSeq = 0;
      // Create a stage + `pending` rows, and optionally a `sent` row at a given age.
      const mkStage = async (opts: {
        providerId: number; phoneId: number; materializedMinsAgo: number | null;
        sentAtMinsAgo?: number | null; releasedMinsAgo?: number | null; pending?: number;
      }) => {
        const st = await one<{ id: number }>(sql`
          INSERT INTO campaign_stages
            (org_id, campaign_id, stage_number, sms_provider_id, provider_phone_id,
             send_approved, scheduled_at, materialized_at, sent_at)
          VALUES (${orgId}, ${camp.id}, ${stageSeq++}, ${opts.providerId}, ${opts.phoneId},
                  true, ${iso(120)},
                  ${opts.materializedMinsAgo == null ? null : iso(opts.materializedMinsAgo)},
                  ${opts.releasedMinsAgo == null ? null : iso(opts.releasedMinsAgo)})
          RETURNING id
        `);
        const pending = opts.pending ?? 3;
        for (let i = 0; i < pending; i++) {
          const contact = await one<{ id: string }>(sql`
            INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${mkNumber()}) RETURNING id
          `);
          await tx.execute(sql`
            INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
            VALUES (${orgId}, ${camp.id}, ${st.id}, ${contact.id}, ${mkNumber()}, ${"m"}, 'pending')
          `);
        }
        if (opts.sentAtMinsAgo != null) {
          const contact = await one<{ id: string }>(sql`
            INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${mkNumber()}) RETURNING id
          `);
          await tx.execute(sql`
            INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
            VALUES (${orgId}, ${camp.id}, ${st.id}, ${contact.id}, ${mkNumber()}, ${"m"}, 'sent', ${iso(opts.sentAtMinsAgo)})
          `);
        }
        return st.id;
      };

      const prov = await mkProvider();
      const ph = await mkPhone(prov);

      // STALLED: materialized 90m ago, released 90m ago, pending rows, last send 60m ago (> 30m threshold).
      const stalled = await mkStage({ providerId: prov, phoneId: ph, materializedMinsAgo: 90, releasedMinsAgo: 90, sentAtMinsAgo: 60 });
      // HEALTHY: same, but last send 5m ago (recent progress) → NOT stalled.
      const healthy = await mkStage({ providerId: prov, phoneId: ph, materializedMinsAgo: 90, releasedMinsAgo: 90, sentAtMinsAgo: 5 });
      // FRESH: materialized 10m ago (< 30m) → too new to judge → NOT stalled.
      const fresh = await mkStage({ providerId: prov, phoneId: ph, materializedMinsAgo: 10, releasedMinsAgo: 10, sentAtMinsAgo: null });
      // OUT-OF-WINDOW: provider window closed now → legitimately held → NOT stalled.
      const closedProv = await mkProvider(false);
      const closedPh = await mkPhone(closedProv);
      const outOfWindow = await mkStage({ providerId: closedProv, phoneId: closedPh, materializedMinsAgo: 90, releasedMinsAgo: 90, sentAtMinsAgo: 60 });
      // PAUSED PROVIDER: known hold, not a silent stall → NOT stalled.
      const pausedProv = await mkProvider(true, true);
      const pausedPh = await mkPhone(pausedProv);
      const paused = await mkStage({ providerId: pausedProv, phoneId: pausedPh, materializedMinsAgo: 90, releasedMinsAgo: 90, sentAtMinsAgo: 60 });

      const result = await findStalledStages(dbc, { now: NOW, thresholdMinutes: 30, orgId });
      const ids = new Set(result.map((r) => r.stage_id));

      check("STALLED stage is flagged", ids.has(stalled), `ids=${[...ids]}`);
      check("HEALTHY (recent send) NOT flagged", !ids.has(healthy));
      check("FRESH (just materialized) NOT flagged", !ids.has(fresh));
      check("OUT-OF-WINDOW NOT flagged", !ids.has(outOfWindow));
      check("PAUSED provider NOT flagged", !ids.has(paused));
      check("exactly one stall detected", result.length === 1, `got ${result.length}`);
      const s = result.find((r) => r.stage_id === stalled);
      check("stall row carries pending count + provider", !!s && s.pending === 3 && s.provider_name === "P", JSON.stringify(s));

      // sends_enabled OFF for the org ⇒ nothing expected to drain ⇒ no stalls.
      await tx.execute(sql`UPDATE org_settings SET sends_enabled = false WHERE org_id = ${orgId}`);
      const offResult = await findStalledStages(dbc, { now: NOW, thresholdMinutes: 30, orgId });
      check("org sends disabled ⇒ no stalls reported", offResult.length === 0, `got ${offResult.length}`);

      console.log("\nAll cases done. Rolling back.");
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) { console.error("\nCRASHED:", err); failed = 1; }
  } finally {
    await pgConn.end({ timeout: 5 });
  }

  if (failed) { console.log(`\nFAILED: ${failed} check(s).`); process.exit(1); }
  console.log("\ntest-stall-detector OK.");
}

main().catch((err) => { console.error("crashed:", err); process.exit(1); });
