// scripts/test-format-interim.ts — 0216 INTERIM drip behaviour (M4.3+): a drip
// message that uses a personalization tag is skipped with ONE
// skipped_ineligible row (reason tags_not_supported_yet), journeys untouched.
// Preview DB, rolled back + source guards on the call order.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-format-interim.ts
//
// Why not runDripSchedulerBatch end-to-end: it runs on the global connection
// across EVERY org, so on the shared preview DB it would mint and queue other
// orgs' routed journeys and could not be rolled back. Both producers call the
// one function tested here, before minting — pinned by G1/G2 below.
import "./_env-preload";
import "./_require-preview-db"; // MUST be second
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import { notifyDripSkips, skipIfTagged, tallySkip, type DripSkipTally } from "@/lib/drip/skip-send";
import { T1_TEMPLATE } from "@/lib/messages/format";

let failed = 0;
const check = (name: string, cond: boolean, detail = "") => { if (!cond) failed++; console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`); };
const ROLLBACK = Symbol("rollback");
// Telegram: fake config + a fetch stub that counts alert calls and never leaves the process.
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";
let telegramCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes("api.telegram.org")) { telegramCalls++; return new Response("{}", { status: 200 }); }
  return realFetch(input, init);
}) as typeof fetch;
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

async function main() {
  console.log("Source guards");
  const sched = strip(readFileSync("lib/drip/scheduler.ts", "utf8"));
  check("G1 scheduler: skipIfTagged runs before the lead's link is minted",
    sched.includes("skipIfTagged(") && sched.indexOf("skipIfTagged(") < sched.indexOf("mintDripLeadLink("));
  const fol = strip(readFileSync("lib/drip/followups.ts", "utf8"));
  check("G2 follow-ups: skipIfTagged runs before dispatchDripSend",
    fol.includes("skipIfTagged(") && fol.indexOf("skipIfTagged(") < fol.indexOf("dispatchDripSend("));
  check("G4 both producers tally and alert the tick's NEW skips", sched.includes("notifyDripSkips(") && fol.includes("notifyDripSkips(") && sched.includes("tallySkip(") && fol.includes("tallySkip("));
  check("G3 the skip never touches journeys (no journey close)", !strip(readFileSync("lib/drip/skip-send.ts", "utf8")).includes("drip_journeys"));

  console.log("\nskipIfTagged (preview, rolled back)");
  try {
    await db.transaction(async (tx) => {
      const sfx = Date.now().toString().slice(-8);
      const one = async <T>(q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as T[])[0];
      const org = (await one<{ id: string }>(sql`SELECT id FROM organizations LIMIT 1`)).id;
      const camp = (await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type, link_mode) VALUES (${org}, ${"fi-" + sfx}, 'fi', 'active', 'drip', 'tracked') RETURNING id`)).id;
      const stage = (await one<{ id: number }>(sql`INSERT INTO campaign_stages (org_id, campaign_id) VALUES (${org}, ${camp}) RETURNING id`)).id;
      const mk = async (n: number) => one<{ contact_id: string; phone: string }>(sql`
        INSERT INTO contacts (org_id, phone_number) VALUES (${org}, ${"+1902" + sfx + n}) RETURNING id AS contact_id, phone_number AS phone`);
      const leads = [await mk(1), await mk(2)];
      const t1 = { kind: "template" as const, formatId: 7, template: T1_TEMPLATE };

      const none = await skipIfTagged(tx, { orgId: org, campaignId: camp, stageId: stage, creativeText: "Hi there", shape: t1, brandName: "G", leads });
      check("M4.3 untagged message ⇒ null (send normally), no rows", none === null);
      const brandOnly = await skipIfTagged(tx, { orgId: org, campaignId: camp, stageId: stage, creativeText: "Hi from {brand}", shape: t1, brandName: "G", leads });
      check("M4.3b {brand} only ⇒ null (renders from the campaign, sends normally)", brandOnly === null);
      const nbStage = (await one<{ id: number }>(sql`INSERT INTO campaign_stages (org_id, campaign_id) VALUES (${org}, ${camp}) RETURNING id`)).id;
      const noBrand = await skipIfTagged(tx, { orgId: org, campaignId: camp, stageId: nbStage, creativeText: "Hi from {brand}", shape: t1, brandName: " ", leads });
      const nbRows = (await tx.execute(sql`SELECT DISTINCT last_error FROM stage_sends WHERE stage_id = ${nbStage}`)) as unknown as { last_error: string }[];
      check("M4.3c {brand} with an EMPTY campaign brand ⇒ skip rows with reason missing_brand (no throw)",
        noBrand?.written === 2 && noBrand.reason === "missing_brand" && nbRows.length === 1 && nbRows[0].last_error === "missing_brand", JSON.stringify({ noBrand, nbRows }));

      const first = await skipIfTagged(tx, { orgId: org, campaignId: camp, stageId: stage, creativeText: "Hi {first_name}", shape: t1, brandName: "G", leads });
      const again = await skipIfTagged(tx, { orgId: org, campaignId: camp, stageId: stage, creativeText: "Hi {first_name}", shape: t1, brandName: "G", leads });
      const rows = (await tx.execute(sql`
        SELECT status, last_error, message_format_id, format_custom, link_id FROM stage_sends WHERE stage_id = ${stage}`)) as unknown as
        { status: string; last_error: string; message_format_id: number | null; format_custom: boolean; link_id: number | null }[];
      check("M4.4 drip first send, tagged ⇒ one skipped_ineligible row per lead, reason tags_not_supported_yet, stamped, no link",
        first?.written === 2 && rows.length === 2 && rows.every((r) => r.status === "skipped_ineligible" && r.last_error === "tags_not_supported_yet"
          && r.message_format_id === 7 && r.format_custom === false && r.link_id === null), JSON.stringify(rows));
      check("M4.5 re-selected next tick ⇒ no second row (idempotent)", again?.written === 0);

      const child = (await one<{ id: number }>(sql`INSERT INTO campaign_stages (org_id, campaign_id) VALUES (${org}, ${camp}) RETURNING id`)).id;
      const custom = { kind: "custom" as const, text: "{zip}<new_row>{creative_text}<new_row>{url}<new_row>{stop_text}" };
      const fu = await skipIfTagged(tx, { orgId: org, campaignId: camp, stageId: child, creativeText: "Hi", shape: custom, brandName: "G", leads: [leads[0]] });
      const fuRow = await one<{ n: number; custom: boolean }>(sql`
        SELECT count(*)::int AS n, bool_and(format_custom) AS custom FROM stage_sends WHERE stage_id = ${child} AND status = 'skipped_ineligible'`);
      check("M4.6 drip follow-up whose CUSTOM text has a tag ⇒ one skip row (already_sent then stops re-selection), format_custom",
        fu?.written === 1 && fuRow.n === 1 && fuRow.custom === true, JSON.stringify({ fu, fuRow }));
      // Review fix: ONE statement per batch (the existing-skip set read once), not one per lead.
      const many = await Promise.all(Array.from({ length: 50 }, (_, k) => mk(100 + k)));
      const bigStage = (await one<{ id: number }>(sql`INSERT INTO campaign_stages (org_id, campaign_id) VALUES (${org}, ${camp}) RETURNING id`)).id;
      let statements = 0;
      const counting = new Proxy(tx, {
        get(target, key, recv) {
          if (key === "execute") return (...a: Parameters<typeof tx.execute>) => { statements++; return target.execute(...a); };
          return Reflect.get(target, key, recv);
        },
      });
      const wrote = await skipIfTagged(counting, { orgId: org, campaignId: camp, stageId: bigStage, creativeText: "Hi {zip}", shape: t1, brandName: "G", leads: many });
      check("M4.7 50 leads ⇒ 50 rows in ONE statement", wrote?.written === 50 && statements === 1, JSON.stringify({ wrote, statements }));
      const half = await skipIfTagged(tx, { orgId: org, campaignId: camp, stageId: bigStage, creativeText: "Hi {zip}", shape: t1, brandName: "G", leads: [...many.slice(0, 10), await mk(999)] });
      check("M4.8 a batch mixing already-skipped and new leads writes only the new one", half?.written === 1, JSON.stringify(half));
      // Ruling 3 (owner 2026-10-19): the interim drip skip ALERTS once per (stage, lead), never every tick —
      // one Telegram per stage per tick, counting only NEWLY skipped leads.
      telegramCalls = 0;
      const tally: DripSkipTally = new Map();
      const alertStage = (await one<{ id: number }>(sql`INSERT INTO campaign_stages (org_id, campaign_id) VALUES (${org}, ${camp}) RETURNING id`)).id;
      const tick = async () => {
        const r = await skipIfTagged(tx, { orgId: org, campaignId: camp, stageId: alertStage, creativeText: "Hi {first_name}", shape: t1, brandName: "G", leads: many.slice(0, 5) });
        tallySkip(tally, { stageId: alertStage, campaignName: "fi", result: r });
        return notifyDripSkips(tally);
      };
      const sent1 = await tick();
      const sent2 = await tick();
      check("M4.9 first tick with 5 new skips ⇒ ONE alert; next tick (same leads) ⇒ no alert",
        sent1 === 1 && sent2 === 0 && telegramCalls === 1, JSON.stringify({ sent1, sent2, telegramCalls }));
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
