// Verifies landing page editing (spec 2026-09-17-landing-page-edit-design.md)
// through the REAL PATCH route on this PR's preview deploy, against the PREVIEW
// database only, with full cleanup.
//
// A throwaway user is created; the signup trigger gives it its own org with an
// OWNER membership (offers.update) and nothing else, so the API resolves that
// org deterministically. Fixtures are inserted into that org and deleted by ID.
// Campaigns are 'paused' + link_mode='manual' with a 2099 schedule, so no cron
// phase can touch them.
//
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=<preview anon key> \
//   BASE_URL=https://camman-<hash>-demian-moors-projects.vercel.app \
//   npx tsx --env-file=C:/AFF/camman/.env.demo scripts/test-landing-page-edit-api.ts
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const PREVIEW_DB_REF = "fdzxzxayhknywvmrhjcj";

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

  const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const pg = postgres(process.env.DATABASE_URL!, { prepare: false });

  const email = `lp-edit-test-${Date.now()}@example.com`;
  const password = `Lp-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  let userId: string | null = null;
  let orgId: string | null = null;
  const ids = { network: 0, offer: 0, brands: [] as number[], pages: [] as number[], campaigns: [] as number[] };

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

    const cookieJar = new Map<string, string>();
    const supabase = createServerClient(supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        getAll: () => Array.from(cookieJar, ([name, value]) => ({ name, value })),
        setAll: (cookies) => {
          for (const { name, value } of cookies) cookieJar.set(name, value);
        },
      },
    });
    const signIn = await supabase.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`sign-in failed: ${signIn.error.message}`);
    const cookie = () => Array.from(cookieJar, ([n, v]) => `${n}=${v}`).join("; ");

    // ── fixtures ────────────────────────────────────────────────────────────
    const tag = `lpedit${Date.now()}`;
    ids.network = (await pg`
      INSERT INTO affiliate_networks (network_id, org_id, name)
      VALUES (${tag}, ${orgId}, ${tag}) RETURNING id`)[0].id;
    ids.offer = (await pg`
      INSERT INTO offers (offer_id, org_id, name, network_id)
      VALUES (${tag}, ${orgId}, ${tag}, ${ids.network}) RETURNING id`)[0].id;
    const hostBrand = (await pg`
      INSERT INTO brands (brand_id, org_id, name, landing_host)
      VALUES (${tag + "h"}, ${orgId}, 'HostBrand', 'www.example.com') RETURNING id`)[0].id;
    const hostlessBrand = (await pg`
      INSERT INTO brands (brand_id, org_id, name)
      VALUES (${tag + "n"}, ${orgId}, 'HostlessBrand') RETURNING id`)[0].id;
    ids.brands.push(hostBrand, hostlessBrand);

    const page = async (title: string, kind: "slug" | "external_url", value: string) => {
      const id = (await pg`
        INSERT INTO offer_landing_pages (org_id, offer_id, title, kind, slug, external_url)
        VALUES (${orgId}, ${ids.offer}, ${title}, ${kind},
                ${kind === "slug" ? value : null}, ${kind === "external_url" ? value : null})
        RETURNING id`)[0].id as number;
      ids.pages.push(id);
      return id;
    };
    const used = await page("Used", "slug", "lpused");
    const urlOnHostless = await page("UrlHostless", "external_url", "https://partner.example/a");
    const free = await page("Free", "slug", "lpfree");
    await page("Clash", "slug", "lpclash");

    const campaign = async (brandId: number, suffix: string) => {
      const id = (await pg`
        INSERT INTO campaigns (org_id, slug, name, status, brand_id, offer_id, link_mode)
        VALUES (${orgId}, ${tag + suffix}, ${tag}, 'paused', ${brandId}, ${ids.offer}, 'manual')
        RETURNING id`)[0].id as number;
      ids.campaigns.push(id);
      return id;
    };
    const cHost = await campaign(hostBrand, "h");
    const cHostless = await campaign(hostlessBrand, "n");
    // One committed (scheduled) stage on each in-use page; nothing materialized.
    await pg`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number, landing_page_id, scheduled_at)
      VALUES (${orgId}, ${cHost}, 1, ${used}, '2099-01-01T15:00:00Z'),
             (${orgId}, ${cHostless}, 1, ${urlOnHostless}, '2099-01-01T15:00:00Z')`;

    // ── HTTP ────────────────────────────────────────────────────────────────
    const url = (pageId: number) => `${base}/api/offers/${ids.offer}/landing-pages/${pageId}`;
    const patch = async (pageId: number, body: unknown) => {
      const res = await fetch(url(pageId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Cookie: cookie() },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON */
      }
      return { status: res.status, json, text };
    };
    const row = async (pageId: number) =>
      (await pg<{ title: string; kind: string; slug: string | null; external_url: string | null }[]>`
        SELECT title, kind, slug, external_url FROM offer_landing_pages WHERE id = ${pageId}`)[0];

    const list = await fetch(`${base}/api/offers/${ids.offer}/landing-pages`, { headers: { Cookie: cookie() } });
    check("GET list resolves the fixture org", list.status === 200, `status ${list.status}`);

    let r = await patch(used, { title: "Renamed" });
    let db = await row(used);
    check("title-only edit on an in-use page saves without confirm", r.status === 200 && db.title === "Renamed" && db.slug === "lpused", `${r.status} ${r.text.slice(0, 160)}`);

    r = await patch(used, { title: "Renamed", kind: "slug", slug: "lpused" });
    check("re-sending the same destination is not a change (no 409)", r.status === 200, `${r.status} ${r.text.slice(0, 160)}`);

    r = await patch(used, { kind: "slug", slug: "lpused2" });
    db = await row(used);
    const details = r.json.details as { affected?: number; committed?: number } | undefined;
    check(
      "slug edit on an in-use page → 409 landing_page_in_use {affected:1, committed:1}",
      r.status === 409 && r.json.code === "landing_page_in_use" && details?.affected === 1 && details?.committed === 1,
      `${r.status} ${r.text.slice(0, 200)}`,
    );
    check("…and nothing was written", db.slug === "lpused");

    r = await patch(used, { kind: "slug", slug: "lpused2", confirm: true });
    db = await row(used);
    check("same edit with confirm → 200 and slug changed", r.status === 200 && db.slug === "lpused2", `${r.status} ${r.text.slice(0, 160)}`);

    r = await patch(urlOnHostless, { kind: "slug", slug: "lpx", confirm: true });
    db = await row(urlOnHostless);
    check(
      "URL→slug with a hostless brand → 400 landing_page_invalid even with confirm",
      r.status === 400 && r.json.code === "landing_page_invalid" && String(r.json.error).includes("HostlessBrand"),
      `${r.status} ${r.text.slice(0, 200)}`,
    );
    check("…and the page is still an external URL", db.kind === "external_url" && db.external_url === "https://partner.example/a");

    r = await patch(free, { kind: "external_url", external_url: "https://partner.example/free" });
    db = await row(free);
    check(
      "slug→URL on an unused page saves without confirm, slug cleared",
      r.status === 200 && db.kind === "external_url" && db.slug === null && db.external_url === "https://partner.example/free",
      `${r.status} ${JSON.stringify(db)}`,
    );

    r = await patch(free, { kind: "slug" });
    check("switch to slug without a slug → 400 validation (field slug)", r.status === 400 && r.json.code === "validation", `${r.status} ${r.text.slice(0, 160)}`);

    r = await patch(free, { kind: "slug", slug: "lpclash" });
    check("slug clash on the offer → 409 duplicate", r.status === 409 && r.json.code === "duplicate", `${r.status} ${r.text.slice(0, 160)}`);

    r = await patch(used, { external_url: "https://partner.example/z" });
    check("URL on a slug page (no kind) → 400 validation", r.status === 400 && r.json.code === "validation", `${r.status} ${r.text.slice(0, 160)}`);
  } finally {
    // Delete by ID, children first.
    if (ids.campaigns.length) {
      await pg`DELETE FROM campaign_stages WHERE campaign_id IN ${pg(ids.campaigns)}`;
      await pg`DELETE FROM campaigns WHERE id IN ${pg(ids.campaigns)}`;
    }
    if (ids.pages.length) await pg`DELETE FROM offer_landing_pages WHERE id IN ${pg(ids.pages)}`;
    if (ids.offer) await pg`DELETE FROM offers WHERE id = ${ids.offer}`;
    if (ids.brands.length) await pg`DELETE FROM brands WHERE id IN ${pg(ids.brands)}`;
    if (ids.network) await pg`DELETE FROM affiliate_networks WHERE id = ${ids.network}`;
    if (userId) {
      await pg`DELETE FROM org_members WHERE user_id = ${userId}`;
      if (orgId) {
        const others = await pg`SELECT 1 FROM org_members WHERE org_id = ${orgId} LIMIT 1`;
        if (others.length === 0) await pg`DELETE FROM organizations WHERE id = ${orgId}`;
      }
      await admin.auth.admin.deleteUser(userId);
    }
    await pg.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
