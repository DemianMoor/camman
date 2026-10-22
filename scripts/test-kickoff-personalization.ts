// P4 Task 4: kickoff renders per recipient for a tagged stage, fails closed on
// any render the eligibility layers should have prevented, and leaves a
// tag-less stage byte-identical.
//   PURE  V.*  validateRecipientBodies (the fail-closed guard, incl. the parity
//              mismatch the layers are supposed to make impossible)
//   DB    K.*  kickoffStageSend on the preview DB, inside a rolled-back tx
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-kickoff-personalization.ts
import "./_env-preload";
import "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { execSync } from "node:child_process";
import { sql } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";
import { NO_RECIPIENT, type RecipientData } from "@/lib/messages/tags";
import { renderMessage, shapeFromStage } from "@/lib/messages/render";
import { kickoffStageSend } from "@/lib/sends/kickoff";
import { computeStageReconciliation } from "@/lib/sends/reconcile";
import { resolveOptOutFooter } from "@/lib/sends/opt-out-footer";
import { loadRecipientAttributes, validateRecipientBodies } from "@/lib/sends/personalize";

// Telegram: fake config + a fetch stub that counts alert calls and never leaves the process.
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";
let telegramCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("api.telegram.org")) {
    telegramCalls++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const ROLLBACK = Symbol("rollback");

function pure() {
  console.log("V — validateRecipientBodies (pure)");
  const shape = { kind: "template" as const, formatId: null, template: "{brand}: {creative_text}<new_row>{url}<new_row>{stop_text}" };
  const render = (r: RecipientData) =>
    renderMessage({ shape, brandName: "Acme", creativeText: "Hi {first_name}", linkUrl: "https://x.co/a", stopText: "Reply STOP to opt out", recipient: r });
  const attrs = new Map<string, RecipientData>([
    ["a", { first_name: "Jose", zip: null, state: null }],
    ["b", { first_name: "Mary", zip: null, state: null }],
  ]);
  const ok = validateRecipientBodies({ recipients: [{ contact_id: "a" }, { contact_id: "b" }], attrs, render, maxSegments: 1, hasStop: () => true });
  bar("V1 every recipient renders and fits ⇒ ok, 0 without STOP", ok.ok && ok.noStop === 0, JSON.stringify(ok));
  // The parity mismatch: a recipient the layers should have skipped reaches kickoff.
  const parity = validateRecipientBodies({ recipients: [{ contact_id: "a" }, { contact_id: "z" }], attrs, render, maxSegments: 1, hasStop: () => true });
  bar("V2 a recipient with missing data ⇒ per_recipient_render_failed (fail closed)", !parity.ok && parity.reason === "per_recipient_render_failed", JSON.stringify(parity));
  const long = validateRecipientBodies({
    recipients: [{ contact_id: "a" }], attrs, maxSegments: 1, hasStop: () => true,
    render: (r) => renderMessage({ shape, brandName: "Acme", creativeText: `Hi {first_name} ${"x".repeat(170)}`, linkUrl: "u", stopText: "STOP", recipient: r }),
  });
  bar("V3 a body over the segment limit ⇒ per_recipient_render_failed", !long.ok && long.reason === "per_recipient_render_failed", JSON.stringify(long));
  const noStop = validateRecipientBodies({ recipients: [{ contact_id: "a" }, { contact_id: "b" }], attrs, render, maxSegments: 1, hasStop: (b) => b.includes("Mary") });
  bar("V4 bodies without STOP are COUNTED (one aggregated alert), not refused here", noStop.ok && noStop.noStop === 1 && noStop.total === 2, JSON.stringify(noStop));
}

async function kickoff() {
  console.log("\nK — kickoffStageSend (preview, rolled back)");
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
  try {
    await db.transaction(async (tx) => {
      const T = tx as unknown as typeof db;
      const one = async <X>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as X[])[0];
      const sfx = Date.now().toString().slice(-7);
      const orgId = (await one<{ id: string }>(sql`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)).id;
      const brand = await one<{ id: number }>(sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${orgId}, ${"k4-" + sfx}, ${"Acme"}) RETURNING id`);
      const SHORT = "https://ex.co/abc";
      let n = 0;
      const mk = async (creativeText: string, stopText: string, names: (string | undefined)[]) => {
        const cre = await one<{ id: number }>(sql`INSERT INTO creatives (slug, org_id, text, status) VALUES (${"k4c-" + sfx + n}, ${orgId}, ${creativeText}, 'active') RETURNING id`);
        const camp = await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id) VALUES (${orgId}, ${"k4-" + sfx + n}, 'k4', 'active', 'manual', ${brand.id}) RETURNING id`);
        const st = await one<{ id: number }>(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, creative_id, short_url, stop_text, include_no_status, include_clickers, exclude_clickers, send_approved, scheduled_at)
          VALUES (${orgId}, ${camp.id}, 1, ${cre.id}, ${SHORT}, ${stopText}, true, false, false, true, now()) RETURNING id`);
        const ids: string[] = [];
        for (let i = 0; i < names.length; i++) {
          const c = await one<{ id: string }>(sql`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}, ${`+1908${sfx}${n}${i}`}) RETURNING id`);
          ids.push(c.id);
          if (names[i] !== undefined) await tx.execute(sql`INSERT INTO contact_attributes (contact_id, org_id, first_name) VALUES (${c.id}, ${orgId}, ${names[i]})`);
          await tx.execute(sql`
            INSERT INTO campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot, was_opt_in_at_snapshot)
            VALUES (${orgId}, ${camp.id}, ${c.id}, true, false, false)`);
        }
        n++;
        return { campaignId: camp.id, stageId: st.id, ids };
      };
      const bodies = async (stageId: number) =>
        ((await tx.execute(sql`SELECT contact_id, rendered_text FROM stage_sends WHERE stage_id = ${stageId} ORDER BY rendered_text`)) as unknown as { contact_id: string; rendered_text: string }[]);

      // K1 tagged: per-recipient names, no rows for the skipped.
      const k1 = await mk("Hi {first_name}, sale today", "Reply STOP to opt out", [undefined, "N/A", "Jose", "Mary"]);
      const r1 = await kickoffStageSend(T, { orgId, campaignId: k1.campaignId, stageId: k1.stageId });
      const b1 = await bodies(k1.stageId);
      bar("K1 tagged stage materializes ok", r1.ok, JSON.stringify(r1));
      bar("K1 rows carry each recipient's own name (\"Hi Jose\", \"Hi Mary\")",
        b1.length === 2 && b1.some((b) => b.rendered_text.includes("Hi Jose,")) && b1.some((b) => b.rendered_text.includes("Hi Mary,")), JSON.stringify(b1.map((b) => b.rendered_text)));
      bar("K1 no rows for the contacts with missing data", !b1.some((b) => b.contact_id === k1.ids[0] || b.contact_id === k1.ids[1]));
      const rec1 = await computeStageReconciliation(T, {
        campaignId: k1.campaignId, orgId, stageId: k1.stageId,
        filters: { includeNoStatus: true, includeClickers: false, excludeClickers: false, splitIndex: null, splitTotal: null },
      });
      bar("K1 reconcile after materialization: missing_tag_data = 2, gap = 0",
        rec1.excluded_by_layer.missing_tag_data === 2 && rec1.gap === 0 && rec1.closed, JSON.stringify({ l: rec1.excluded_by_layer, gap: rec1.gap }));

      // K2 tag-less T1: exactly the T1 body every recipient got before P4.
      const k2 = await mk("Big sale today", "Reply STOP to opt out", [undefined, "Jose"]);
      const r2 = await kickoffStageSend(T, { orgId, campaignId: k2.campaignId, stageId: k2.stageId });
      const b2 = await bodies(k2.stageId);
      const tmpl = await one<{ template: string | null }>(sql`SELECT template FROM message_formats WHERE org_id = ${orgId}::uuid AND is_default`);
      const expected = renderMessage({
        shape: shapeFromStage({ message_format_id: null, custom_text: null, format_template: tmpl?.template ?? null }),
        brandName: "Acme", creativeText: "Big sale today", linkUrl: SHORT,
        stopText: resolveOptOutFooter({ stageStopText: "Reply STOP to opt out" }).text, recipient: NO_RECIPIENT,
      });
      bar("K2 tag-less stage: every recipient (attributes or not) gets the identical T1 body",
        r2.ok && b2.length === 2 && expected.ok && b2.every((b) => b.rendered_text === (expected.ok ? expected.body : "")), JSON.stringify(b2.map((b) => b.rendered_text)));

      // K3 dry-run provider (none set ⇒ not txr), no STOP in the footer: ONE alert for 3 recipients.
      warns.length = 0;
      telegramCalls = 0;
      const k3 = await mk("Hi {first_name}", "Thanks", ["Ann", "Bob", "Cid"]);
      const r3 = await kickoffStageSend(T, { orgId, campaignId: k3.campaignId, stageId: k3.stageId });
      const dry = warns.filter((w) => w.includes("[optout-guard][dryrun]"));
      await new Promise((res) => setTimeout(res, 50)); // the alert is fire-and-forget
      bar("K3 dry-run: sends (not refused), exactly ONE aggregated warning + ONE Telegram alert naming 3 of 3",
        r3.ok && dry.length === 1 && dry[0].includes("3 of 3") && telegramCalls === 1, JSON.stringify({ r3, dry, telegramCalls }));

      // K5 multi-tenancy (CLAUDE.md §3): attributes are read under the org that owns them only.
      const own = await loadRecipientAttributes(T, orgId, [k1.ids[2]]);
      const foreign = await loadRecipientAttributes(T, "00000000-0000-0000-0000-000000000000", [k1.ids[2]]);
      bar("K5 loadRecipientAttributes is org-scoped (own org ⇒ Jose, another org ⇒ nothing)",
        own.get(k1.ids[2])?.first_name === "Jose" && foreign.size === 0, JSON.stringify({ own: [...own], foreign: [...foreign] }));

      // K4 everyone missing ⇒ no_recipients.
      const k4 = await mk("Hi {first_name}", "Reply STOP to opt out", [undefined, "N/A"]);
      const r4 = await kickoffStageSend(T, { orgId, campaignId: k4.campaignId, stageId: k4.stageId });
      bar("K4 all recipients missing data ⇒ refused no_recipients", !r4.ok && r4.reason === "no_recipients", JSON.stringify(r4));

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  } finally {
    console.warn = origWarn;
  }
}

function grepBar() {
  console.log("\nG — the interim refusal is gone from the send path (drip keeps its own until P5)");
  let hits = "";
  try { hits = execSync("git grep -l tags_not_supported_yet -- lib/sends", { encoding: "utf8" }).trim(); } catch { /* exit 1 = no match */ }
  bar("G1 `tags_not_supported_yet` is absent from lib/sends/", hits === "", hits);
}

async function main() {
  pure();
  grepBar();
  await kickoff();
  await pgConn.end({ timeout: 5 });
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
