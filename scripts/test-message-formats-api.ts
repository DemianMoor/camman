// scripts/test-message-formats-api.ts — 0216 routes over HTTP against a PR PREVIEW
// (route wiring + auth + the stage list's has_sent / shape columns).
// Throwaway users (owner, operator), each in the org its signup trigger creates;
// fixtures by id; full teardown.
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=<preview anon> BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app \
//     npx tsx --conditions=react-server --env-file=D:/AFF/camman/.env.demo scripts/test-message-formats-api.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const BASE = process.env.BASE_URL ?? "";
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${cond || !detail ? "" : ` — ${detail}`}`);
}
type Res = { status: number; body: Record<string, unknown> };
const reason = (r: Res) => (r.body.details as { reason?: string } | undefined)?.reason;

async function main() {
  if (!BASE || /camman\.vercel\.app$/.test(new URL(BASE).host)) {
    console.error("BASE_URL must be a PREVIEW deployment URL.");
    process.exit(2);
  }
  console.log(`target ${BASE}  db ${requirePreviewDb().label}\n`);
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const made: { userId: string; orgId: string | null }[] = [];

  async function session(role: "owner" | "operator") {
    const email = `t216-${role}-${Date.now()}@example.com`;
    const password = `T216-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`createUser: ${created.error?.message}`);
    const rec = { userId: created.data.user.id, orgId: null as string | null };
    made.push(rec);
    const [m] = await sql<{ org_id: string }[]>`SELECT org_id FROM org_members WHERE user_id = ${rec.userId}::uuid`;
    rec.orgId = m.org_id;
    await sql`UPDATE org_members SET role = ${role} WHERE user_id = ${rec.userId}::uuid`;
    const jar: { name: string; value: string }[] = [];
    const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        getAll: () => jar,
        setAll: (list) => {
          for (const c of list) {
            const i = jar.findIndex((x) => x.name === c.name);
            if (i >= 0) jar[i] = { name: c.name, value: c.value };
            else jar.push({ name: c.name, value: c.value });
          }
        },
      },
    });
    const signIn = await sb.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`signIn ${role}: ${signIn.error.message}`);
    const cookie = jar.map((c) => `${c.name}=${c.value}`).join("; ");
    const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
      });
      let j: Record<string, unknown> = {};
      try { j = (await r.json()) as Record<string, unknown>; } catch { /* non-JSON */ }
      return { status: r.status, body: j };
    };
    return { orgId: rec.orgId, call };
  }

  /** campaign (+ creative + stage) in the org; optionally a SENT row on the stage. */
  // materialized: stamps campaign_stages.materialized_at — the REGULAR format lock (spec R4, P4).
  async function fixture(orgId: string, type: "regular" | "drip", sent: boolean, materialized: boolean) {
    const sfx = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const [cre] = await sql<{ id: number }[]>`
      INSERT INTO creatives (slug, org_id, text, status) VALUES (${"t216-" + sfx}, ${orgId}::uuid, 'Hi there', 'active') RETURNING id`;
    const [cre2] = await sql<{ id: number }[]>`
      INSERT INTO creatives (slug, org_id, text, status) VALUES (${"t216b-" + sfx}, ${orgId}::uuid, 'Hello again', 'active') RETURNING id`;
    const [camp] = await sql<{ id: number }[]>`
      INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
      VALUES (${orgId}::uuid, ${"t216-" + sfx}, 't216', 'draft', ${type}, 'manual') RETURNING id`;
    const [st] = await sql<{ id: number }[]>`
      INSERT INTO campaign_stages (org_id, campaign_id, creative_id, materialized_at)
      VALUES (${orgId}::uuid, ${camp.id}, ${cre.id}, ${materialized ? sql`now()` : null}) RETURNING id`;
    if (sent) {
      const [c] = await sql<{ id: string }[]>`INSERT INTO contacts (org_id, phone_number) VALUES (${orgId}::uuid, ${"+1903" + sfx.slice(-7)}) RETURNING id`;
      await sql`INSERT INTO stage_sends (id, org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status, sent_at)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${camp.id}, ${st.id}, ${c.id}::uuid, ${"+1903" + sfx.slice(-7)}, 'x', 'sent', now())`;
    }
    return { campaignId: camp.id, stageId: st.id, otherCreativeId: cre2.id };
  }

  try {
    console.log("── owner");
    const owner = await session("owner");
    const list = await owner.call("GET", "/api/message-formats/list");
    const fmts = (list.body.data as { id: number; name: string; is_default: boolean }[]) ?? [];
    check("owner: GET list 200 with T1 (default) / T2 / T3 seeded for a brand-new org",
      list.status === 200 && fmts.length === 3 && fmts[0].is_default, `${list.status} ${JSON.stringify(list.body).slice(0, 200)}`);
    const t2 = fmts.find((f) => f.name.startsWith("T2"))!;
    const bad = await owner.call("POST", "/api/message-formats", { name: "x", template: "{first_name} {creative_text}{url}{stop_text}" });
    check("owner: POST template with a tag ⇒ 400 unknown_token", bad.status === 400 && reason(bad) === "unknown_token", JSON.stringify(bad));
    const mk = await owner.call("POST", "/api/message-formats", { name: "T4", template: "{creative_text}<new_row>{stop_text}<new_row>{url}" });
    check("owner: POST valid ⇒ 201", mk.status === 201, JSON.stringify(mk));
    const off = await owner.call("PATCH", `/api/message-formats/${mk.body.id}`, { is_enabled: false });
    check("owner: disable unused ⇒ 200", off.status === 200 && off.body.is_enabled === false, JSON.stringify(off));
    const mkDef = await owner.call("POST", `/api/message-formats/${mk.body.id}/make-default`);
    check("owner: make a disabled format default ⇒ 409 format_disabled", mkDef.status === 409 && reason(mkDef) === "format_disabled", JSON.stringify(mkDef));

    const fx = await fixture(owner.orgId!, "regular", false, false);
    const stages = await owner.call("GET", `/api/campaigns/${fx.campaignId}/stages`);
    const row = ((stages.body.data as Record<string, unknown>[]) ?? [])[0] ?? {};
    check("owner: stage list carries message_format_id (= default), custom_text null, has_sent false",
      stages.status === 200 && row.message_format_id === fmts[0].id && row.custom_text === null && row.has_sent === false,
      `${stages.status} ${JSON.stringify(row).slice(0, 300)}`);
    const noCreative = await owner.call("PATCH", `/api/campaigns/${fx.campaignId}/stages/${fx.stageId}`, { custom_text: "Hi {url} {stop_text}" });
    check("owner: custom text without {creative_text} ⇒ 400 custom_text_missing_required_block",
      noCreative.status === 400 && reason(noCreative) === "custom_text_missing_required_block", JSON.stringify(noCreative));
    const custom = "Hey!<new_row>{creative_text}<new_row>{url}<new_row>{stop_text}";
    const setCustom = await owner.call("PATCH", `/api/campaigns/${fx.campaignId}/stages/${fx.stageId}`, { custom_text: custom });
    const [stored] = await sql<{ custom_text: string | null; message_format_id: number | null }[]>`
      SELECT custom_text, message_format_id FROM campaign_stages WHERE id = ${fx.stageId}`;
    check("owner: set custom text ⇒ 200, stored, format cleared", setCustom.status === 200 && stored.custom_text === custom && stored.message_format_id === null,
      `${setCustom.status} ${JSON.stringify(setCustom.body).slice(0, 200)} ${JSON.stringify(stored)}`);

    const fxSent = await fixture(owner.orgId!, "regular", true, true);
    const sentList = await owner.call("GET", `/api/campaigns/${fxSent.campaignId}/stages`);
    const sentRow = ((sentList.body.data as Record<string, unknown>[]) ?? [])[0] ?? {};
    check("owner: has_sent true once a sent row exists (stage list)", sentRow.has_sent === true, JSON.stringify(sentRow).slice(0, 200));
    const locked = await owner.call("PATCH", `/api/campaigns/${fxSent.campaignId}/stages/${fxSent.stageId}`, { message_format_id: t2.id });
    check("owner: change format after send ⇒ 409 format_locked_after_send", locked.status === 409 && reason(locked) === "format_locked_after_send", JSON.stringify(locked));
    const echo = await owner.call("PATCH", `/api/campaigns/${fxSent.campaignId}/stages/${fxSent.stageId}`, { message_format_id: fmts[0].id, label: "echo" });
    check("owner: echo of the same format after send ⇒ 200", echo.status === 200, JSON.stringify(echo).slice(0, 200));
    // P4 (spec R4): a REGULAR stage locks once materialized, before any send.
    const fxPrepared = await fixture(owner.orgId!, "regular", false, true);
    const prepLocked = await owner.call("PATCH", `/api/campaigns/${fxPrepared.campaignId}/stages/${fxPrepared.stageId}`, { message_format_id: t2.id });
    check("owner: regular stage materialized, not yet sent ⇒ 409 format_locked_after_send", prepLocked.status === 409 && reason(prepLocked) === "format_locked_after_send", JSON.stringify(prepLocked));
    const dripPrepared = await fixture(owner.orgId!, "drip", false, true);
    const dripPrepOk = await owner.call("PATCH", `/api/campaigns/${dripPrepared.campaignId}/stages/${dripPrepared.stageId}`, { message_format_id: t2.id });
    check("owner: drip stage materialized, not yet sent ⇒ 200 (drip locks at first send)", dripPrepOk.status === 200, JSON.stringify(dripPrepOk).slice(0, 200));
    const dripSentFx = await fixture(owner.orgId!, "drip", true, false);
    const dripSentLocked = await owner.call("PATCH", `/api/campaigns/${dripSentFx.campaignId}/stages/${dripSentFx.stageId}`, { message_format_id: t2.id });
    check("owner: drip stage with a sent row ⇒ 409 format_locked_after_send", dripSentLocked.status === 409 && reason(dripSentLocked) === "format_locked_after_send", JSON.stringify(dripSentLocked));

    // Owner 2026-10-22: CSV export of a stage whose message uses a contact tag is
    // blocked until the export carries each recipient's rendered body.
    console.log("── export of a personalized stage");
    const fxTag = await fixture(owner.orgId!, "regular", false, false);
    await sql`UPDATE creatives SET text = 'Hi {first_name}' WHERE id = (SELECT creative_id FROM campaign_stages WHERE id = ${fxTag.stageId})`;
    const expTag = await owner.call("GET", `/api/campaigns/${fxTag.campaignId}/stages/${fxTag.stageId}/export-phones`);
    check("owner: export of a {first_name} stage ⇒ 409 personalization_tags_not_exportable, clear message",
      expTag.status === 409 && reason(expTag) === "personalization_tags_not_exportable" &&
        JSON.stringify(expTag.body).includes("This stage uses personalization tags — export not supported"), JSON.stringify(expTag).slice(0, 300));
    const expPlain = await owner.call("GET", `/api/campaigns/${fx.campaignId}/stages/${fx.stageId}/export-phones`);
    check("owner: export of a tag-less stage is not blocked for tags", reason(expPlain) !== "personalization_tags_not_exportable", JSON.stringify(expPlain).slice(0, 200));

    console.log("── operator");
    const op = await session("operator");
    const opList = await op.call("GET", "/api/message-formats/list");
    check("operator: GET list 200", opList.status === 200, `${opList.status}`);
    const opPost = await op.call("POST", "/api/message-formats", { name: "x", template: "{creative_text}{url}{stop_text}" });
    check("operator: POST format ⇒ 403", opPost.status === 403, `${opPost.status}`);
    const opFmts = (opList.body.data as { id: number }[]) ?? [];
    const opPatch = await op.call("PATCH", `/api/message-formats/${opFmts[0]?.id}`, { name: "x" });
    check("operator: PATCH format ⇒ 403", opPatch.status === 403, `${opPatch.status}`);
    const opFx = await fixture(op.orgId!, "regular", false, false);
    const opCustom = await op.call("PATCH", `/api/campaigns/${opFx.campaignId}/stages/${opFx.stageId}`, { custom_text: custom });
    check("operator: set custom text ⇒ 403 compliance_field_locked", opCustom.status === 403 && reason(opCustom) === "compliance_field_locked", JSON.stringify(opCustom));
    const opT2 = (opFmts as { id: number; name?: string }[]).find((f) => f.name?.startsWith("T2"));
    const opPick = await op.call("PATCH", `/api/campaigns/${opFx.campaignId}/stages/${opFx.stageId}`, { message_format_id: opT2?.id });
    check("operator: pick another enabled format ⇒ 200", opPick.status === 200, JSON.stringify(opPick).slice(0, 200));
    const drip = await fixture(op.orgId!, "drip", true, false);
    const swap = await op.call("PATCH", `/api/campaigns/${drip.campaignId}/stages/${drip.stageId}`, { creative_id: drip.otherCreativeId });
    check("operator: drip creative change after send ⇒ 409 creative_locked_after_send", swap.status === 409 && reason(swap) === "creative_locked_after_send", JSON.stringify(swap));
  } finally {
    for (const r of made) {
      if (r.orgId) {
        await sql`DELETE FROM stage_sends WHERE org_id = ${r.orgId}::uuid`;
        await sql`DELETE FROM campaigns WHERE org_id = ${r.orgId}::uuid`;
        await sql`DELETE FROM org_members WHERE user_id = ${r.userId}::uuid`;
        const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM org_members WHERE org_id = ${r.orgId}::uuid`;
        if (n === 0) await sql`DELETE FROM organizations WHERE id = ${r.orgId}::uuid`;
      }
      await admin.auth.admin.deleteUser(r.userId);
    }
    const orgs = made.map((m) => m.orgId).filter(Boolean) as string[];
    const left = orgs.length
      ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM organizations WHERE id = ANY(${`{${orgs.join(",")}}`}::uuid[])`
      : [{ n: 0 }];
    const users = await admin.auth.admin.listUsers({ perPage: 1000 });
    const leftUsers = users.data?.users.filter((u) => u.email?.startsWith("t216-")).length ?? -1;
    check(`teardown: 0 fixture orgs (${left[0].n}), 0 fixture users (${leftUsers})`, left[0].n === 0 && leftUsers === 0);
    await sql.end({ timeout: 5 });
  }
  console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) FAILED.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
