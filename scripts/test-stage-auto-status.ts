// Verifies the automatic stage status moves (ClickUp 869evxbgb, migration 0179)
// on the PREVIEW environment, against an ISOLATED manual-mode fixture in the
// preview operator's org (operator-test@exuma.io), with full cleanup. link_mode='manual' +
// send_approved=false is inert to both cron phases, so nothing is ever sent
// (same fixture pattern as test-cancel-rematerialize.ts).
//
// Library (real kickoffStageSend; cancel replays the abort route's writes):
//   1. budget hit mid-materialization → stays 'draft' (only COMPLETE moves it)
//   2. materialization completes → 'pending', previous_status 'draft', one
//      system event (actor NULL, automatic)
//   3. re-Prepare of a complete stage → no second move, no second event
//   4. cancel → back to 'draft'
//   5. hand-picked 'draft' → a complete materialization leaves it 'draft'
//   6. hand-picked 'pending' → a cancel leaves it 'pending'
// HTTP (the real route handlers on this PR's preview deploy):
//   7. POST …/send/abort moves a system 'pending' back to 'draft'
//   8. POST …/status marks the stage manual; Prepare then leaves it 'draft'
//   9. POST …/stages/bulk-status marks the stage manual
//
// Needs migration 0179 and the PR preview, so it refuses anything else:
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=<preview anon key> \
//   BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app \
//   npx tsx --conditions=react-server --env-file=C:/AFF/camman/.env.demo scripts/test-stage-auto-status.ts
import "./_env-preload";

import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { kickoffStageSend } from "@/lib/sends/kickoff";
import { autoMoveStageStatus, logAutoStatusMove, type AutoStatusMove } from "@/lib/stages/auto-status";

const PREVIEW_DB_REF = "fdzxzxayhknywvmrhjcj";
const TAG = "__wt-stage-auto-status-test__";
const OPERATOR_EMAIL = "operator-test@exuma.io";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✓" : "✗ FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (ok) pass++;
  else fail++;
}

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const base = process.env.BASE_URL ?? "";
  if (!(process.env.DATABASE_URL ?? "").includes(PREVIEW_DB_REF) || !supabaseUrl.includes(PREVIEW_DB_REF)) {
    console.error(`Refusing to run: DATABASE_URL and NEXT_PUBLIC_SUPABASE_URL must both be the preview project (${PREVIEW_DB_REF}).`);
    process.exit(1);
  }
  if (!/^https:\/\/camman-[a-z0-9]+-demian-moors-projects\.vercel\.app$/.test(base)) {
    console.error("Refusing to run: BASE_URL must be a camman-* preview deployment.");
    process.exit(1);
  }

  // Sign in as the preview operator, the role that runs Prepare / cancel / status
  // day to day. Same provisioning as verify-operator-access.ts: the user exists on
  // the preview project with a random password, reset here through the service
  // role (a password change doesn't end anyone else's session).
  const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const users = await admin.auth.admin.listUsers({ perPage: 200 });
  const operator = users.data?.users.find((u) => u.email === OPERATOR_EMAIL);
  if (!operator) {
    throw new Error(`${OPERATOR_EMAIL} is not on the preview project; run verify-operator-access.ts once`);
  }
  const password = `Op-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const reset = await admin.auth.admin.updateUserById(operator.id, { password });
  if (reset.error) throw new Error(`password reset failed: ${reset.error.message}`);

  // The routes read the SSR auth cookies.
  const cookieJar = new Map<string, string>();
  const supabase = createServerClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => Array.from(cookieJar, ([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) cookieJar.set(name, value);
      },
    },
  });
  const signIn = await supabase.auth.signInWithPassword({ email: OPERATOR_EMAIL, password });
  if (signIn.error || !signIn.data.user) throw new Error(`sign-in failed: ${signIn.error?.message}`);
  const cookie = () => Array.from(cookieJar, ([n, v]) => `${n}=${v}`).join("; ");
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie() },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };

  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });
  const db = drizzle(pg);
  const dbc = db as unknown as Parameters<typeof kickoffStageSend>[0];

  let campaignId: number | null = null;
  try {
    const seed = (
      await db.execute(sql`
        SELECT m.org_id, m.role, c.brand_id, cr.id AS creative_id
        FROM org_members m
        JOIN campaigns c ON c.org_id = m.org_id AND c.brand_id IS NOT NULL
        JOIN creatives cr ON cr.org_id = m.org_id AND cr.text IS NOT NULL
        WHERE m.user_id = ${signIn.data.user.id} AND m.role = 'operator' AND m.is_active
        ORDER BY length(cr.text)
        LIMIT 1`)
    )[0] as { org_id: string; role: string; brand_id: number; creative_id: number } | undefined;
    if (!seed) throw new Error("test user has no org with a branded campaign and a creative");
    const orgId = seed.org_id;
    const contacts = (await db.execute(sql`
      SELECT id FROM contacts
      WHERE org_id = ${orgId} AND is_archived = false
        AND id NOT IN (SELECT contact_id FROM opt_outs WHERE org_id = ${orgId})
      LIMIT 5`)) as unknown as { id: string }[];
    if (contacts.length < 5) throw new Error("need >=5 usable contacts");

    const cid = Number(
      (
        await db.execute(sql`
          INSERT INTO campaigns (org_id, brand_id, slug, name, status, link_mode)
          VALUES (${orgId}, ${seed.brand_id}, ${TAG + "-" + Date.now()}, ${TAG}, 'active', 'manual')
          RETURNING id`)
      )[0].id,
    );
    campaignId = cid;
    for (const c of contacts) {
      await db.execute(sql`
        INSERT INTO campaign_audience_pool
          (org_id, campaign_id, contact_id, was_no_status_at_snapshot, was_clicker_at_snapshot)
        VALUES (${orgId}, ${cid}, ${c.id}, true, false)`);
    }
    const createStage = async (stageNumber: number) =>
      Number(
        (
          await db.execute(sql`
            INSERT INTO campaign_stages
              (org_id, campaign_id, stage_number, creative_id, short_url, stop_text,
               scheduled_at, send_approved, include_no_status, include_clickers, exclude_clickers)
            VALUES (${orgId}, ${cid}, ${stageNumber}, ${seed.creative_id},
                    'https://example.com/x', 'Reply STOP to opt out',
                    now() - interval '1 minute', false, true, false, false)
            RETURNING id`)
        )[0].id,
      );
    const stage = async (id: number) =>
      (
        (await db.execute(sql`
          SELECT status, previous_status, status_set_manually, materialized_at
          FROM campaign_stages WHERE id = ${id}`)) as unknown as {
          status: string;
          previous_status: string | null;
          status_set_manually: boolean;
          materialized_at: string | null;
        }[]
      )[0];
    const autoEvents = async (id: number) =>
      Number(
        (
          (await db.execute(sql`
            SELECT count(*)::int AS n FROM campaign_events
            WHERE stage_id = ${id} AND event_type = 'stage_status_changed'
              AND actor_user_id IS NULL AND metadata->>'automatic' = 'true'`)) as unknown as {
            n: number;
          }[]
        )[0].n,
      );
    const kickoff = (id: number, budgetMs?: number) =>
      kickoffStageSend(dbc, { orgId, campaignId: cid, stageId: id, budgetMs });

    const stageId = await createStage(1);
    // The API resolves ONE of the user's memberships (getApiMembershipRow,
    // LIMIT 1) and this user has two. Prove it lands on the fixture's org before
    // trusting any route result below.
    const probe = await fetch(`${base}/api/campaigns/${cid}/stages`, { headers: { Cookie: cookie() } });
    if (probe.status !== 200) {
      throw new Error(`the API does not resolve the fixture org for ${OPERATOR_EMAIL} (GET stages → ${probe.status})`);
    }
    console.log(`fixture: org role ${seed.role}, campaign ${cid}, stage ${stageId}, pool ${contacts.length}\n`);

    // The abort route's writes, in its order (app/api/campaigns/[campaignId]/
    // stages/[stageId]/send/abort/route.ts). Steps 7 and 9 call the route itself.
    const cancelReplay = () =>
      db.transaction(async (tx) => {
        const t = tx as unknown as Parameters<typeof autoMoveStageStatus>[0];
        await tx.execute(sql`
          UPDATE stage_sends SET status = 'rejected'
          WHERE stage_id = ${stageId} AND org_id = ${orgId} AND status = 'pending'`);
        await tx.execute(sql`
          UPDATE campaign_stages
          SET send_approved = false, schedule_missed_at = NULL, materialized_at = NULL
          WHERE id = ${stageId} AND org_id = ${orgId}`);
        const move: AutoStatusMove = {
          orgId, campaignId: cid, stageId, from: "pending", to: "draft", reason: "send cancelled",
        };
        const moved = await autoMoveStageStatus(t, move);
        if (moved != null) await logAutoStatusMove(t, move, moved);
      });
    // The status route's write, for the library-level steps.
    const setManually = (status: string) =>
      db.execute(sql`
        UPDATE campaign_stages
        SET status = ${status}, previous_status = status, status_changed_at = now(),
            status_set_manually = true
        WHERE id = ${stageId} AND org_id = ${orgId}`);

    const s0 = await stage(stageId);
    check("new stage starts 'draft', not manual", s0.status === "draft" && !s0.status_set_manually, JSON.stringify(s0));

    console.log("1) budget hit mid-materialization:");
    const r1 = await kickoff(stageId, 0);
    check("kickoff incomplete", r1.ok && r1.complete === false, JSON.stringify(r1));
    const s1 = await stage(stageId);
    check("materialized_at still NULL", s1.materialized_at == null);
    check("status still 'draft'", s1.status === "draft", s1.status);
    check("no automatic event", (await autoEvents(stageId)) === 0);

    console.log("2) materialization completes:");
    const r2 = await kickoff(stageId);
    check("kickoff complete", r2.ok && r2.complete === true && r2.materialized > 0, JSON.stringify(r2));
    const s2 = await stage(stageId);
    check("materialized_at stamped", s2.materialized_at != null);
    check("status 'pending'", s2.status === "pending", s2.status);
    check("previous_status 'draft'", s2.previous_status === "draft", String(s2.previous_status));
    check("still not manual", s2.status_set_manually === false);
    check("1 automatic event (actor NULL)", (await autoEvents(stageId)) === 1, String(await autoEvents(stageId)));

    console.log("3) re-Prepare a complete stage:");
    const r3 = await kickoff(stageId);
    check("kickoff no-op complete", r3.ok && r3.complete === true && r3.materialized === 0, JSON.stringify(r3));
    check("status still 'pending'", (await stage(stageId)).status === "pending");
    check("still 1 automatic event", (await autoEvents(stageId)) === 1, String(await autoEvents(stageId)));

    console.log("4) cancel the prepared send:");
    await cancelReplay();
    const s4 = await stage(stageId);
    check("materialized_at reset", s4.materialized_at == null);
    check("status back to 'draft'", s4.status === "draft", s4.status);
    check("previous_status 'pending'", s4.previous_status === "pending", String(s4.previous_status));
    check("2 automatic events", (await autoEvents(stageId)) === 2, String(await autoEvents(stageId)));

    console.log("5) hand-picked 'draft', then Prepare:");
    await setManually("draft");
    const r5 = await kickoff(stageId);
    check("kickoff complete", r5.ok && r5.complete === true && r5.materialized > 0, JSON.stringify(r5));
    const s5 = await stage(stageId);
    check("materialized_at stamped", s5.materialized_at != null);
    check("status stays 'draft' (manual wins)", s5.status === "draft", s5.status);
    check("no new automatic event", (await autoEvents(stageId)) === 2, String(await autoEvents(stageId)));

    console.log("6) hand-picked 'pending', then cancel:");
    await setManually("pending");
    await cancelReplay();
    const s6 = await stage(stageId);
    check("materialized_at reset", s6.materialized_at == null);
    check("status stays 'pending' (manual wins)", s6.status === "pending", s6.status);
    check("no new automatic event", (await autoEvents(stageId)) === 2, String(await autoEvents(stageId)));

    console.log("7) HTTP: POST send/abort on a system-set Pending:");
    const st2 = await createStage(2);
    const r7 = await kickoff(st2);
    check("kickoff complete → 'pending'", r7.ok && r7.complete && (await stage(st2)).status === "pending", JSON.stringify(r7));
    const a7 = await post(`/api/campaigns/${cid}/stages/${st2}/send/abort`, {});
    check("send/abort → 200", a7.status === 200, `${a7.status} ${a7.text.slice(0, 200)}`);
    const s7 = await stage(st2);
    check("materialized_at reset", s7.materialized_at == null);
    check("status back to 'draft'", s7.status === "draft", s7.status);
    check("2 automatic events (prepared + cancelled)", (await autoEvents(st2)) === 2, String(await autoEvents(st2)));

    console.log("8) HTTP: POST status 'draft', then Prepare:");
    const a8 = await post(`/api/campaigns/${cid}/stages/${st2}/status`, { status: "draft" });
    check("status → 200", a8.status === 200, `${a8.status} ${a8.text.slice(0, 200)}`);
    check("status_set_manually = true", (await stage(st2)).status_set_manually === true);
    const r8 = await kickoff(st2);
    check("kickoff complete", r8.ok && r8.complete === true && r8.materialized > 0, JSON.stringify(r8));
    check("status stays 'draft' (manual wins)", (await stage(st2)).status === "draft", (await stage(st2)).status);
    // bulk-status can only target success/failed/cancelled/archived, none of which
    // the automatic moves ever match, so the flag is the observable effect here.
    console.log("9) HTTP: POST bulk-status 'cancelled':");
    const st3 = await createStage(3);
    check("new stage not manual", (await stage(st3)).status_set_manually === false);
    const a9 = await post(`/api/campaigns/${cid}/stages/bulk-status`, {
      stage_ids: [st3],
      target_status: "cancelled",
      confirm: true,
    });
    const bulk = a9.status === 200 ? (JSON.parse(a9.text) as { succeeded: number[] }) : null;
    check("bulk-status → 200, stage succeeded", bulk?.succeeded.includes(st3) === true, `${a9.status} ${a9.text.slice(0, 200)}`);
    const s9 = await stage(st3);
    check("status 'cancelled'", s9.status === "cancelled", s9.status);
    check("status_set_manually = true", s9.status_set_manually === true);
  } finally {
    if (campaignId != null) {
      await db.execute(sql`DELETE FROM campaign_events WHERE campaign_id = ${campaignId}`);
      await db.execute(sql`DELETE FROM stage_sends WHERE campaign_id = ${campaignId}`);
      await db.execute(sql`DELETE FROM campaign_audience_pool WHERE campaign_id = ${campaignId}`);
      await db.execute(sql`DELETE FROM campaign_stages WHERE campaign_id = ${campaignId}`);
      await db.execute(sql`DELETE FROM campaigns WHERE id = ${campaignId}`);
    }
    await pg.end({ timeout: 5 });
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
