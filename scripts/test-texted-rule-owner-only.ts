import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// The "Texted in the last…" rule is owner-only until its 14-night trial
// completes (owner, 2026-10-05; lib/segments/texted-rule-availability.ts).
// Real routes on a local server (`npm run dev:preview`).
//
//   O1  owner: GET says available; POST texted → 201
//   M1  manager, no streak: GET says unavailable
//   M2  …POST texted → 403 texted_rule_trial_pending
//   M3  …PATCH switching another rule TO texted → 403
//   M4  …PATCH editing an EXISTING texted rule (operator) → 200 (not "adding")
//   M5  …POST another rule type → 201 (only the texted type is gated)
//   S1  manager, streak = 14: GET says available; POST texted → 201
// The test user's role is restored, the trial row restored, and the probe
// segment deleted by id in `finally`.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-texted-rule-owner-only.ts

import { createServerClient } from "@supabase/ssr";
import { sql } from "drizzle-orm";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { db } = await import("@/db/client");
  const { TEXTED_TRIAL_KEY } = await import("@/lib/segments/texted-rule-trial");
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

  const [me] = (await db.execute(sql`
    select m.org_id, m.user_id, m.role from org_members m join auth.users u on u.id = m.user_id
    where u.email = ${process.env.TEST_USER_EMAIL!} limit 1`)) as unknown as { org_id: string; user_id: string; role: string }[];
  const [trialBefore] = (await db.execute(sql`
    select data from operator_rollups where org_id = ${me.org_id}::uuid and rollup_key = ${TEXTED_TRIAL_KEY}`)) as unknown as { data: unknown }[];
  const setRole = (role: string) =>
    db.execute(sql`update org_members set role = ${role} where org_id = ${me.org_id}::uuid and user_id = ${me.user_id}::uuid`);
  const setStreak = (n: number | null) =>
    n === null
      ? db.execute(sql`delete from operator_rollups where org_id = ${me.org_id}::uuid and rollup_key = ${TEXTED_TRIAL_KEY}`)
      : db.execute(sql`
          insert into operator_rollups (org_id, rollup_key, data, computed_at, updated_at)
          values (${me.org_id}::uuid, ${TEXTED_TRIAL_KEY}, ${JSON.stringify({ streak: n, last_run_day: null, last_clean_day: null, last_drift_at: null, last_report: null })}::jsonb, now(), now())
          on conflict (org_id, rollup_key) do update set data = excluded.data`);

  const tag = String(Date.now()).slice(-6);
  const [seg] = (await db.execute(sql`
    insert into segments (org_id, segment_id, name) values (${me.org_id}::uuid, ${"own-" + tag}, ${"owner-only probe " + tag}) returning id`)) as unknown as { id: number }[];
  const rulesUrl = `/api/segments/${seg.id}/rules`;
  const post = (rule_type: string, value: unknown) =>
    api(rulesUrl, { method: "POST", body: JSON.stringify({ rule_type, operator: "is_not", value: value ?? null }) });
  const available = async () => ((await (await api(rulesUrl)).json()) as { texted_rule_available?: boolean }).texted_rule_available;

  try {
    bar("precondition: the test user starts as owner", me.role === "owner", me.role);
    await setStreak(null);

    // O1
    bar("O1 owner: GET says available", (await available()) === true);
    const o1 = await post("texted_in_last_period", "3d");
    const o1j = (await o1.json()) as { id?: number; data?: { id?: number } };
    const textedId = o1j.id ?? o1j.data?.id;
    bar("O1 owner: POST texted → 201", o1.status === 201 && textedId != null, `${o1.status}`);

    // M1-M5 as manager, no streak
    await setRole("manager");
    bar("M1 manager, no streak: GET says unavailable", (await available()) === false);
    const m2 = await post("texted_in_last_period", "1w");
    const m2j = (await m2.json()) as { details?: { reason?: string } };
    bar("M2 manager: POST texted → 403 texted_rule_trial_pending", m2.status === 403 && m2j.details?.reason === "texted_rule_trial_pending", `${m2.status} ${m2j.details?.reason}`);
    const m5 = await api(rulesUrl, { method: "POST", body: JSON.stringify({ rule_type: "is_clicker_any_brand", operator: "is", value: null }) });
    const m5j = (await m5.json()) as { id?: number; data?: { id?: number } };
    const otherId = m5j.id ?? m5j.data?.id;
    bar("M5 manager: POST another rule type → 201", m5.status === 201, `${m5.status}`);
    const m3 = await api(`${rulesUrl}/${otherId}`, { method: "PATCH", body: JSON.stringify({ rule_type: "texted_in_last_period", operator: "is_not", value: "1w" }) });
    bar("M3 manager: PATCH switching a rule TO texted → 403", m3.status === 403, `${m3.status}`);
    const m4 = await api(`${rulesUrl}/${textedId}`, { method: "PATCH", body: JSON.stringify({ operator: "is" }) });
    bar("M4 manager: PATCH editing an existing texted rule → 200", m4.status === 200, `${m4.status}`);

    // S1 manager, streak complete
    await setStreak(14);
    bar("S1 manager, streak 14: GET says available", (await available()) === true);
    const s1 = await post("texted_in_last_period", "2w");
    bar("S1 manager, streak 14: POST texted → 201", s1.status === 201, `${s1.status}`);
  } finally {
    await setRole(me.role);
    if (trialBefore) {
      await db.execute(sql`
        insert into operator_rollups (org_id, rollup_key, data, computed_at, updated_at)
        values (${me.org_id}::uuid, ${TEXTED_TRIAL_KEY}, ${JSON.stringify(trialBefore.data)}::jsonb, now(), now())
        on conflict (org_id, rollup_key) do update set data = excluded.data`);
    } else await setStreak(null);
    await db.execute(sql`delete from segment_rules where segment_id = ${seg.id}::int`);
    await db.execute(sql`delete from segment_stats where segment_id = ${seg.id}::int`);
    await db.execute(sql`delete from segments where id = ${seg.id}::int`);
    const [r] = (await db.execute(sql`
      select role from org_members where org_id = ${me.org_id}::uuid and user_id = ${me.user_id}::uuid`)) as unknown as { role: string }[];
    console.log(`\n  teardown: role restored to ${r.role}; probe segment ${seg.id} deleted`);
    if (r.role !== me.role) fail++;
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
