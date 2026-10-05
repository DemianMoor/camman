import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// Task 3 §4b / T2b (migration 0197): stages sent OUTSIDE the drain (manual CSV
// export) leave a record that their contacts were texted, and no delete path
// can erase it. Real routes on a local server (`npm run dev:preview`) for
// export / status / bulk-status; deleteStage() called directly.
//
//   M1  export with limit 2 → rows for A, B; sent_at NULL (exported ≠ sent)
//   M2  mark sent (status route) → A, B stamped; C has no row
//   M3  deleteStage → 409, rows kept
//   M4  raw DELETE of the stage → foreign-key error (any path is blocked)
//   M5  raw DELETE of the campaign → foreign-key error
//   M6  sent → success keeps the stamps; un-mark (→ pending) clears them
//   M7  second export (no limit) adds C; bulk-status 'success' straight from
//       pending stamps A, B, C (texted without ever being 'sent')
//   M8  bulk 'cancelled', then bulk archive, keep the stamps
//   M9  nothing written to stage_sends
//   M10 a stage that was only EXPORTED (never marked) deletes, rows cleared
//   M11 an organization delete still works (rolled back)
// The rule's own reading of these rows is task T2 (not built yet).
// Fixture: synthetic contacts / campaign / stages, removed BY ID at the end.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-manual-send-visibility.ts

import { createServerClient } from "@supabase/ssr";
import { sql } from "drizzle-orm";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const pgCode = (e: unknown): string | undefined =>
  (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
const arr = (xs: (string | number)[]) => `{${xs.join(",")}}`;

async function main() {
  const { db } = await import("@/db/client");
  const { deleteStage } = await import("@/lib/stages/delete-stage");
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  const jar = new Map<string, string>();
  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cs) => cs.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { error } = await sb.auth.signInWithPassword({
    email: process.env.TEST_USER_EMAIL!,
    password: process.env.TEST_USER_PASSWORD!,
  });
  if (error) throw error;
  const api = (path: string, init?: RequestInit) =>
    fetch(`${appUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; ") },
    });
  const [{ org_id: orgId }] = (await db.execute(sql`
    select m.org_id from org_members m join auth.users u on u.id = m.user_id
    where u.email = ${process.env.TEST_USER_EMAIL!} limit 1`)) as unknown as { org_id: string }[];

  const tag = String(Date.now()).slice(-6);
  const ids = { contacts: [] as string[], campaign: 0, stages: [] as number[] };
  const rowsOf = async (stageId: number) =>
    (await db.execute(sql`
      select contact_id, sent_at from stage_manual_recipients
      where stage_id = ${stageId}::int order by contact_id`)) as unknown as { contact_id: string; sent_at: string | null }[];
  const setStatus = (stageId: number, status: string) =>
    api(`/api/campaigns/${ids.campaign}/stages/${stageId}/status`, { method: "POST", body: JSON.stringify({ status }) });
  const bulk = (stageIds: number[], target_status: string) =>
    api(`/api/campaigns/${ids.campaign}/stages/bulk-status`, {
      method: "POST",
      body: JSON.stringify({ stage_ids: stageIds, target_status, confirm: true }),
    });

  try {
    for (let i = 0; i < 3; i++) {
      const [c] = (await db.execute(sql`
        insert into contacts (org_id, phone_number, messaging_status)
        values (${orgId}::uuid, ${`+1555${tag}${i}`}, 'eligible') returning id`)) as unknown as { id: string }[];
      ids.contacts.push(c.id);
    }
    ids.contacts.sort();
    const [A, B, C] = ids.contacts;
    const [camp] = (await db.execute(sql`
      insert into campaigns (org_id, slug, name, status, link_mode)
      values (${orgId}::uuid, ${"msv-" + tag}, 'manual-send visibility probe', 'active', 'manual')
      returning id`)) as unknown as { id: number }[];
    ids.campaign = camp.id;
    for (const n of [1, 2]) {
      const [s] = (await db.execute(sql`
        insert into campaign_stages (org_id, campaign_id, stage_number, status, tracking_id, include_no_status)
        values (${orgId}::uuid, ${camp.id}, ${n}, 'pending', ${`msv-${tag}-s${n}`}, true)
        returning id`)) as unknown as { id: number }[];
      ids.stages.push(s.id);
    }
    const [S1, S2] = ids.stages;
    await db.execute(sql`
      insert into campaign_audience_pool (org_id, campaign_id, contact_id, was_no_status_at_snapshot)
      select ${orgId}::uuid, ${camp.id}, unnest(${arr(ids.contacts)}::uuid[]), true`);

    // M1
    const e1 = await api(`/api/campaigns/${camp.id}/stages/${S1}/export-phones?limit=2`);
    const lines1 = (await e1.text()).trim().split("\n");
    let r = await rowsOf(S1);
    bar("M1 export (limit 2) answers a 2-row CSV", e1.ok && lines1.length === 3, `${e1.status} ${lines1.length - 1} rows`);
    bar(
      "M1 rows recorded for A and B, not yet sent",
      r.length === 2 && r[0].contact_id === A && r[1].contact_id === B && r.every((x) => x.sent_at === null),
      JSON.stringify(r.map((x) => [x.contact_id.slice(0, 4), x.sent_at])),
    );

    // M2
    const m2 = await setStatus(S1, "sent");
    r = await rowsOf(S1);
    bar("M2 mark sent → A and B stamped", m2.ok && r.length === 2 && r.every((x) => x.sent_at !== null), `${m2.status}`);
    bar("M2 C (not exported) has no row", !r.some((x) => x.contact_id === C));

    // M3
    const d3 = await deleteStage({ orgId, campaignId: camp.id, stageId: S1 });
    bar("M3 deleteStage refuses the marked stage (409)", !d3.ok && d3.status === 409, JSON.stringify(d3).slice(0, 80));
    bar("M3 rows kept", (await rowsOf(S1)).length === 2);

    // M4 / M5 — each attempt in its own transaction, rolled back if it succeeds
    const attempts: [string, ReturnType<typeof sql>][] = [
      ["M4 raw DELETE of the stage is refused by the foreign key", sql`delete from campaign_stages where id = ${S1}::int`],
      ["M5 raw DELETE of the campaign is refused by the foreign key", sql`delete from campaigns where id = ${camp.id}::int`],
    ];
    for (const [label, stmt] of attempts) {
      let code: string | undefined;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(stmt);
          throw Object.assign(new Error("deleted — rolling back"), { code: "DELETED" });
        });
      } catch (e) {
        code = pgCode(e);
      }
      bar(label, code === "23503", code ?? "no error");
    }
    bar("M4/M5 rows still there", (await rowsOf(S1)).length === 2);

    // M6
    const stampsBefore = (await rowsOf(S1)).map((x) => x.sent_at);
    const m6a = await setStatus(S1, "success");
    r = await rowsOf(S1);
    bar("M6 sent → success keeps the stamps unchanged", m6a.ok && JSON.stringify(r.map((x) => x.sent_at)) === JSON.stringify(stampsBefore), `${m6a.status}`);
    const m6 = await setStatus(S1, "pending");
    r = await rowsOf(S1);
    bar("M6 un-mark (sent → pending) clears the stamps", m6.ok && r.length === 2 && r.every((x) => x.sent_at === null), `${m6.status}`);

    // M7
    await (await api(`/api/campaigns/${camp.id}/stages/${S1}/export-phones`)).text();
    const b7 = await bulk([S1], "success");
    const b7j = (await b7.json()) as { succeeded?: number[] };
    r = await rowsOf(S1);
    bar("M7 second export adds C (A, B not duplicated)", r.length === 3 && r.some((x) => x.contact_id === C));
    bar("M7 bulk-status 'success' from pending stamps A, B and C", (b7j.succeeded ?? []).includes(S1) && r.every((x) => x.sent_at !== null), JSON.stringify(b7j));

    // M8
    const b8a = await bulk([S1], "cancelled");
    r = await rowsOf(S1);
    bar("M8 bulk 'cancelled' keeps the stamps", b8a.ok && r.length === 3 && r.every((x) => x.sent_at !== null));
    const b8 = await bulk([S1], "archived");
    r = await rowsOf(S1);
    bar("M8 bulk archive keeps the stamps", b8.ok && r.length === 3 && r.every((x) => x.sent_at !== null));

    // M9
    const [ss] = (await db.execute(sql`
      select count(*)::int n from stage_sends where stage_id = any(${arr(ids.stages)}::int[])`)) as unknown as { n: number }[];
    bar("M9 nothing written to stage_sends", ss.n === 0, `${ss.n}`);

    // M10
    await (await api(`/api/campaigns/${camp.id}/stages/${S2}/export-phones`)).text();
    const before10 = (await rowsOf(S2)).length;
    const d10 = await deleteStage({ orgId, campaignId: camp.id, stageId: S2 });
    const [left10] = (await db.execute(sql`
      select count(*)::int n from campaign_stages where id = ${S2}::int`)) as unknown as { n: number }[];
    bar(
      "M10 an exported-only stage deletes, its rows cleared",
      before10 === 3 && d10.ok && left10.n === 0 && (await rowsOf(S2)).length === 0,
      `rows before ${before10}, ${JSON.stringify(d10).slice(0, 60)}`,
    );
    if (d10.ok) ids.stages = ids.stages.filter((x) => x !== S2);

    // M11
    let orgCode: string | undefined;
    try {
      await db.transaction(async (tx) => {
        const [o] = (await tx.execute(sql`
          insert into organizations (name) values ('msv org probe') returning id`)) as unknown as { id: string }[];
        const [c] = (await tx.execute(sql`
          insert into contacts (org_id, phone_number) values (${o.id}::uuid, '+15550000001') returning id`)) as unknown as { id: string }[];
        const [k] = (await tx.execute(sql`
          insert into campaigns (org_id, slug, name) values (${o.id}::uuid, ${"msv-org-" + tag}, 'p') returning id`)) as unknown as { id: number }[];
        const [s] = (await tx.execute(sql`
          insert into campaign_stages (org_id, campaign_id, stage_number) values (${o.id}::uuid, ${k.id}, 1) returning id`)) as unknown as { id: number }[];
        await tx.execute(sql`
          insert into stage_manual_recipients (org_id, stage_id, contact_id, sent_at)
          values (${o.id}::uuid, ${s.id}, ${c.id}::uuid, now())`);
        await tx.execute(sql`delete from organizations where id = ${o.id}::uuid`);
        throw Object.assign(new Error("org deleted — rolling back"), { code: "ORG_DELETED" });
      });
    } catch (e) {
      orgCode = pgCode(e);
    }
    bar("M11 an organization delete still works (rolled back)", orgCode === "ORG_DELETED", orgCode ?? "no error");
  } finally {
    // Teardown by ID. Marked rows block the stage delete by design, so they go
    // first, explicitly.
    if (ids.stages.length)
      await db.execute(sql`delete from stage_manual_recipients where stage_id = any(${arr(ids.stages)}::int[])`);
    if (ids.campaign) {
      await db.execute(sql`delete from campaign_audience_pool where campaign_id = ${ids.campaign}::int`);
      await db.execute(sql`delete from campaign_stages where campaign_id = ${ids.campaign}::int`);
      await db.execute(sql`delete from campaigns where id = ${ids.campaign}::int`);
    }
    if (ids.contacts.length)
      await db.execute(sql`delete from contacts where id = any(${arr(ids.contacts)}::uuid[])`);
    const [left] = (await db.execute(sql`
      select (select count(*) from campaigns where id = ${ids.campaign}::int)::int
           + (select count(*) from contacts where id = any(${arr(ids.contacts.length ? ids.contacts : ["00000000-0000-0000-0000-000000000000"])}::uuid[]))::int as n`)) as unknown as { n: number }[];
    console.log(`\nTeardown: ${Number(left.n) === 0 ? "fixture removed" : "FIXTURE STILL PRESENT"}`);
    if (Number(left.n) !== 0) fail++;
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
