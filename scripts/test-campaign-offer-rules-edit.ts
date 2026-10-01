import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// Card 869fad9c9: the campaign's offer-rule parameters (offer_cooldown_days /
// offer_limit_times) round-trip through the edit screen's API.
//
//   R1 a draft created with 14 / 3 → GET returns 14 / 3 (the GET used to omit
//      both, so the edit screen showed and previewed 7 / 5);
//   R2 PATCH a DRAFT to 21 / 2 → saved, GET returns 21 / 2;
//   R3 PATCH a NON-draft campaign's cooldown → 400 audience_locked_after_draft,
//      and the stored value does not move.
// Creates ONE draft and deletes it by id. Needs `npm run dev:preview`.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-campaign-offer-rules-edit.ts

import { createServerClient } from "@supabase/ssr";
import { sql } from "drizzle-orm";

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
  const api = (path: string, init?: RequestInit) =>
    fetch(`${appUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
      },
    });
  const getRules = async (id: number) => {
    const j = (await (await api(`/api/campaigns/${id}`)).json()) as Record<string, unknown>;
    const d = (j.data ?? j) as { offer_cooldown_days?: number; offer_limit_times?: number };
    return { cd: d.offer_cooldown_days, lt: d.offer_limit_times };
  };

  let draftId: number | null = null;
  try {
    const created = await api("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: `offer-rules-edit ${Date.now()}`,
        save_as_draft: true,
        exclude_prior_offer_contacts: true,
        offer_cooldown_days: 14,
        offer_limit_times: 3,
      }),
    });
    const cj = (await created.json()) as { id?: number; data?: { id?: number }; error?: string };
    draftId = cj.id ?? cj.data?.id ?? null;
    bar("a draft can be created", created.status === 201 && draftId != null, `${created.status} ${cj.error ?? ""}`);
    if (draftId == null) throw new Error("no draft");

    const r1 = await getRules(draftId);
    bar("R1 GET returns the stored cooldown / limit (14 / 3)", r1.cd === 14 && r1.lt === 3, JSON.stringify(r1));

    const p2 = await api(`/api/campaigns/${draftId}`, {
      method: "PATCH",
      body: JSON.stringify({ offer_cooldown_days: 21, offer_limit_times: 2 }),
    });
    const r2 = await getRules(draftId);
    bar("R2 PATCH on a DRAFT saves (21 / 2)", p2.status === 200 && r2.cd === 21 && r2.lt === 2, `${p2.status} ${JSON.stringify(r2)}`);

    // A non-draft campaign in the test user's org (any; nothing is changed).
    const [nd] = (await db.execute(sql`
      select c.id from campaigns c
      join org_members m on m.org_id = c.org_id
      join auth.users u on u.id = m.user_id
      where u.email = ${process.env.TEST_USER_EMAIL!} and c.status in ('active','paused','completed')
      order by c.id limit 1`)) as unknown as { id: number }[];
    bar("a non-draft campaign exists to try", !!nd);
    if (nd) {
      const before = await getRules(nd.id);
      const p3 = await api(`/api/campaigns/${nd.id}`, {
        method: "PATCH",
        body: JSON.stringify({ offer_cooldown_days: (before.cd ?? 7) + 1 }),
      });
      const b3 = (await p3.json().catch(() => ({}))) as { details?: { reason?: string } };
      const after = await getRules(nd.id);
      bar(
        "R3 PATCH on a NON-draft is refused as audience_locked_after_draft, value unchanged",
        p3.status === 400 && b3.details?.reason === "audience_locked_after_draft" && after.cd === before.cd,
        `${p3.status} ${b3.details?.reason} ${before.cd}→${after.cd}`,
      );
    }
  } finally {
    if (draftId != null) {
      await db.execute(sql`delete from campaigns where id = ${draftId}::int and status = 'draft'`);
      const left = (await db.execute(sql`select count(*)::int n from campaigns where id = ${draftId}::int`)) as unknown as { n: number }[];
      console.log(`\nTeardown: draft ${draftId} ${left[0].n === 0 ? "deleted" : "STILL PRESENT"}`);
      if (left[0].n !== 0) fail++;
    }
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
