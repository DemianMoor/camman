import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// Card 869fb60y2: POST /api/campaigns/[id]/duplicate copies every campaigns
// column it should. The source draft gets a NON-default value in each copyable
// field (offer rules, lifecycle_rules, link_mode 'tracked', default phone, …),
// so a dropped column shows up as a difference instead of passing by
// coincidence with its default. Then EVERY column of the copy is compared with
// the source, except the ones a copy intentionally starts fresh. A future
// column therefore fails here too, not only at compile time.
// Creates two drafts and deletes both by id. Needs `npm run dev:preview`.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-campaign-duplicate-fields.ts

import { createServerClient } from "@supabase/ssr";
import { sql } from "drizzle-orm";

// Fresh by design: the route's NOT_COPIED, plus what it sets anew.
const FRESH = new Set([
  "id", "human_id", "tracking_id", "status", "previous_status", "status_changed_at",
  "send_paused", "send_paused_reason", "send_paused_at", "archived_at", "created_at",
  "slug", "name", "created_by_user_id", "audience_snapshot_count",
]);

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { db } = await import("@/db/client");
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

  const [org] = (await db.execute(sql`
    select m.org_id, m.user_id from org_members m join auth.users u on u.id = m.user_id
    where u.email = ${process.env.TEST_USER_EMAIL!} limit 1`)) as unknown as { org_id: string; user_id: string }[];
  const [phone] = (await db.execute(sql`
    select id from provider_phones where org_id = ${org.org_id}::uuid order by id limit 1`)) as unknown as { id: number }[];
  bar("a provider phone exists to set as the default send-from number", !!phone);

  const ids: number[] = [];
  try {
    const [src] = (await db.execute(sql`
      insert into campaigns (org_id, slug, name, status, notes, audience_cap,
        exclude_in_use_contacts, exclude_prior_offer_contacts, offer_rules_enabled,
        offer_cooldown_days, offer_limit_times, lifecycle_rules, link_mode,
        default_provider_phone_id, audience_filters, assigned_to_user_id)
      values (${org.org_id}::uuid, ${"dupf-" + Date.now()}, 'dup-fields probe', 'draft', 'probe notes', 1234,
        false, true, true, 21, 3, true, 'tracked', ${phone?.id ?? null}, '{"lifecycle_statuses":["cold"]}'::jsonb,
        ${org.user_id}::uuid) -- set, so it is compared (a source with none is assigned to the caller by design)
      returning id`)) as unknown as { id: number }[];
    ids.push(src.id);

    const res = await fetch(`${appUrl}/api/campaigns/${src.id}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; ") },
      body: "{}",
    });
    const j = (await res.json()) as { id?: number; data?: { id?: number }; error?: string };
    const copyId = j.id ?? j.data?.id;
    bar("the duplicate route answers 2xx with the copy's id", res.ok && copyId != null, `${res.status} ${j.error ?? ""}`);
    if (copyId == null) return;
    ids.push(copyId);

    const rows = (await db.execute(sql`
      select to_jsonb(c) as r from campaigns c where c.id in (${src.id}, ${copyId}) order by c.id`)) as unknown as { r: Record<string, unknown> }[];
    const [a, b] = rows.map((x) => x.r);
    const compared = Object.keys(a).filter((k) => !FRESH.has(k));
    const differing = compared.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    bar(
      `every non-fresh column of the copy equals the source (${compared.length} columns)`,
      differing.length === 0,
      differing.map((k) => `${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`).join("; "),
    );
    for (const k of ["exclude_prior_offer_contacts", "offer_rules_enabled", "offer_cooldown_days", "offer_limit_times", "lifecycle_rules", "link_mode", "default_provider_phone_id"])
      bar(`  ${k} copied (${JSON.stringify(a[k])})`, JSON.stringify(a[k]) === JSON.stringify(b[k]));
    bar("the copy is a fresh draft", b.status === "draft" && b.human_id == null && b.tracking_id == null);
  } finally {
    for (const id of ids.reverse())
      await db.execute(sql`delete from campaigns where id = ${id}::int and status = 'draft'`);
    const left = (await db.execute(sql`select count(*)::int n from campaigns where id = any(${`{${ids.join(",")}}`}::int[])`)) as unknown as { n: number }[];
    console.log(`\nTeardown: ${ids.length} draft(s) ${left[0].n === 0 ? "deleted" : "STILL PRESENT"}`);
    if (left[0].n !== 0) fail++;
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
