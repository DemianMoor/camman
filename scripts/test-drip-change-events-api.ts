// Drip settings change log through the THREE REAL ROUTES on this PR's preview
// deploy, against the PREVIEW database only, with full cleanup by ID.
//
// A throwaway user is created; the signup trigger gives it its own org with an
// OWNER membership, so the API resolves that org deterministically. The drip
// campaign is 'paused' in an org with drip posture off, so no cron touches it.
//
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=<preview anon key> \
//   BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app \
//   npx tsx --env-file=C:/AFF/camman/.env.demo scripts/test-drip-change-events-api.ts
import { requirePreviewDb } from "./_require-preview-db"; // MUST be first — refuses any target but the preview DB

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

let fail = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✓" : "✗ FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!ok) fail++;
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const base = process.env.BASE_URL ?? "";
  const preview = requirePreviewDb();
  if (!supabaseUrl.includes(preview.ref)) {
    console.error(`Refusing to run: NEXT_PUBLIC_SUPABASE_URL must be the same preview project (${preview.ref}).`);
    process.exit(1);
  }
  if (!/^https:\/\/camman-[a-z0-9]+-demian-moors-projects\.vercel\.app$/.test(base)) {
    console.error("Refusing to run: BASE_URL must be a camman-* preview deployment.");
    process.exit(1);
  }
  console.log(`Target: ${preview.label} via ${base}\n`);

  const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });

  const email = `drip-change-events-${Date.now()}@example.com`;
  const password = `Dce-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  let userId: string | null = null;
  let orgId: string | null = null;
  let campaignId: number | null = null;

  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`createUser failed: ${created.error?.message}`);
    userId = created.data.user.id;
    const memberships = await pg<{ org_id: string; role: string }[]>`
      SELECT org_id, role FROM org_members WHERE user_id = ${userId}`;
    if (memberships.length !== 1 || memberships[0].role !== "owner") {
      throw new Error(`expected exactly one owner membership, got ${JSON.stringify(memberships)}`);
    }
    orgId = memberships[0].org_id;

    const jar = new Map<string, string>();
    const supabase = createServerClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
        setAll: (cookies) => {
          for (const { name, value } of cookies) jar.set(name, value);
        },
      },
    });
    const signIn = await supabase.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`sign-in failed: ${signIn.error.message}`);
    const cookie = () => Array.from(jar, ([n, v]) => `${n}=${v}`).join("; ");
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { Cookie: cookie(), "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
      return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
    };

    // ── fixtures ──────────────────────────────────────────────────────────
    const [c] = await pg<{ id: number }[]>`
      INSERT INTO campaigns (org_id, slug, name, status, type)
      VALUES (${orgId}, ${"dce-api-" + Date.now()}, 'DCE API test', 'paused', 'drip') RETURNING id`;
    campaignId = c.id;
    await pg`
      INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, campaign_cap, carry_days)
      VALUES (${campaignId}, ${orgId}, 'dceapi', 300, 0)`;
    const [s] = await pg<{ id: number }[]>`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, window_start_min, window_end_min, drip_active)
      VALUES (${orgId}, ${campaignId}, 1, 540, 1020, false) RETURNING id`;
    const stageId = s.id;
    const events = () => pg<{ event_type: string; stage_id: number | null; actor_user_id: string | null;
      metadata: { changes: Record<string, { from: unknown; to: unknown }> } }[]>`
      SELECT event_type, stage_id, actor_user_id, metadata FROM campaign_events
      WHERE campaign_id = ${campaignId} ORDER BY id`;

    const probe = await call("GET", `/api/campaigns/${campaignId}/drip-config`);
    check("A0 API resolves the fixture org (GET drip-config 200)", probe.status === 200, String(probe.status));
    if (probe.status !== 200) throw new Error("org not resolved — refusing to continue");

    const cfg = { interest_tag: "dceapi", campaign_cap: 300, carry_days: 0 };
    let r = await call("PUT", `/api/campaigns/${campaignId}/drip-config`, cfg);
    check("A1 PUT unchanged config → 200, no event", r.status === 200 && (await events()).length === 0, String(r.status));

    r = await call("PUT", `/api/campaigns/${campaignId}/drip-config`, { ...cfg, campaign_cap: 500, carry_days: 1 });
    let ev = await events();
    const ch = ev[0]?.metadata?.changes ?? {};
    check("A2 PUT cap + carry change → one drip_config_changed",
      r.status === 200 && ev.length === 1 && ev[0].event_type === "drip_config_changed", JSON.stringify(ev.map((e) => e.event_type)));
    check("A3 its changes are exactly campaign_cap 300→500, carry_days 0→1",
      Object.keys(ch).sort().join(",") === "campaign_cap,carry_days" &&
        ch.campaign_cap?.from === 300 && ch.campaign_cap?.to === 500 &&
        ch.carry_days?.from === 0 && ch.carry_days?.to === 1, JSON.stringify(ch));
    check("A4 actor is the signed-in user", ev[0]?.actor_user_id === userId);

    r = await call("POST", `/api/campaigns/${campaignId}/drip-followups`, { behavioral_enabled: true });
    ev = await events();
    check("A5 POST drip-followups on → behavioral_enabled logged",
      r.status === 200 && ev.length === 2 && ev[1]?.metadata?.changes?.behavioral_enabled?.to === true,
      `${r.status} ${JSON.stringify(ev[1]?.metadata)}`);

    r = await call("PATCH", `/api/campaigns/${campaignId}/stages/${stageId}`, { window_start_min: 600, window_end_min: 1080 });
    ev = await events();
    const sc = ev[2]?.metadata?.changes ?? {};
    check("A6 PATCH stage window → one drip_stage_changed on that stage",
      r.status === 200 && ev.length === 3 && ev[2]?.event_type === "drip_stage_changed" && ev[2]?.stage_id === stageId,
      `${r.status} ${JSON.stringify(r.json)}`);
    check("A7 its changes are exactly the window",
      Object.keys(sc).sort().join(",") === "window_end_min,window_start_min" &&
        sc.window_start_min?.to === 600 && sc.window_end_min?.to === 1080, JSON.stringify(sc));

    r = await call("PATCH", `/api/campaigns/${campaignId}/stages/${stageId}`, { window_start_min: 600, window_end_min: 1080 });
    check("A8 PATCH same window again → 200, no event", r.status === 200 && (await events()).length === 3, String(r.status));

    r = await call("PATCH", `/api/campaigns/${campaignId}/stages/${stageId}`, { label: "renamed" });
    check("A9 PATCH a non-drip field → 200, no event", r.status === 200 && (await events()).length === 3, String(r.status));
  } finally {
    // Delete by ID. campaign_events / configs / stages (incl. follow-up children) cascade from the campaign.
    if (campaignId) await pg`DELETE FROM campaigns WHERE id = ${campaignId} AND org_id = ${orgId}`;
    if (userId) {
      await pg`DELETE FROM org_members WHERE user_id = ${userId}`;
      if (orgId) {
        const others = await pg`SELECT 1 FROM org_members WHERE org_id = ${orgId} LIMIT 1`;
        if (others.length === 0) await pg`DELETE FROM organizations WHERE id = ${orgId}`;
      }
      await admin.auth.admin.deleteUser(userId);
    }
    if (campaignId) {
      const left = await pg`SELECT 1 FROM campaign_events WHERE campaign_id = ${campaignId} LIMIT 1`;
      check("Z cleanup: no events left for the fixture campaign", left.length === 0);
    }
    await pg.end();
  }

  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
