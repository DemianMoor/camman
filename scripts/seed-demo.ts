// Seed the EXTERNAL DEMO environment with synthetic data.
//
//   npx tsx scripts/seed-demo.ts            # seed (idempotent)
//   npx tsx scripts/seed-demo.ts --dry-run  # guards + scope only, no writes
//
// This script DELIBERATELY does not load .env.local. Every other script in this
// repo does, and .env.local carries the PRODUCTION DATABASE_URL — a seed that
// silently picked it up would write synthetic contacts into the live tenant.
// Pass the demo connection explicitly:
//
//   DATABASE_URL=... NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   TEST_USER_EMAIL=... TEST_USER_PASSWORD=... npx tsx scripts/seed-demo.ts
//
// ── Safety model (four independent guards, all BEFORE any write) ─────────────
//   1. Host allowlist   — the connection host must be the demo Supabase pooler.
//                         Prod's host aborts immediately.
//   2. Foreign-org      — if the DB holds an organization this script did not
//                         create, abort. Prod has exactly such an org, so even a
//                         host-guard bypass cannot write there.
//   3. Domain guard     — no seeded URL may reference a production domain.
//   4. Already-seeded   — re-running is a no-op, not a duplicate.
//
// Providers are seeded on the "no-API" path on purpose: an sms_provider_id that
// is NOT in the adapter registry (txh/txh2/ahi/txr), supports_api_send=false,
// and zero provider_credentials rows. Each alone blocks a send; together they
// make an accidental dispatch structurally impossible. See docs/09-demo-environment.md.

import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

// ── configuration ───────────────────────────────────────────────────────────

const DEMO_DB_HOSTS = [
  "aws-0-eu-central-1.pooler.supabase.com",
  "aws-1-eu-central-1.pooler.supabase.com",
];
const DEMO_DB_USER_PREFIX = "postgres.fdzxzxayhknywvmrhjcj";

// Substrings that must never appear in seeded content. These are the live
// tracking/admin hosts; a demo that emitted them would send reviewers' clicks
// into production analytics.
const FORBIDDEN_DOMAINS = ["gdkn.org", "go.gdkn", "admin.gdkn"];

const ORG_NAME = "CamMan Demo";
const BRAND_KEY = "DEMO-BRAND";
const CONTACT_COUNT = 500;

const DRY_RUN = process.argv.includes("--dry-run");

function fail(msg: string): never {
  console.error(`\nABORT: ${msg}`);
  process.exit(1);
}

// Deterministic PRNG — a re-seed after a wipe reproduces the same dataset, so
// screenshots and bug reports stay comparable across rebuilds.
let seed = 20260814;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length)]!;
}

// ── guard 1: connection host ────────────────────────────────────────────────

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) fail("DATABASE_URL is not set (pass it explicitly — .env.local is not loaded)");

const parsed = new URL(dbUrl);
console.log("=== CONNECTION SCOPE (pre-write) ===");
console.log(`  host    : ${parsed.hostname}`);
console.log(`  port    : ${parsed.port}`);
console.log(`  user    : ${parsed.username}`);
console.log(`  database: ${parsed.pathname.slice(1)}`);

if (!DEMO_DB_HOSTS.includes(parsed.hostname)) {
  fail(
    `host '${parsed.hostname}' is not a demo host.\n` +
      `        Allowed: ${DEMO_DB_HOSTS.join(", ")}`,
  );
}
if (!parsed.username.startsWith(DEMO_DB_USER_PREFIX)) {
  fail(`user '${parsed.username}' is not the demo project user (${DEMO_DB_USER_PREFIX})`);
}
console.log("  guard   : PASS (demo host + demo project user)");

// ── guard 3 (static half): demo site origin carries no prod domain ──────────

const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://camman-v2.vercel.app")
  .trim()
  .replace(/\/+$/, "");
const shortDomain = new URL(siteUrl).host;
for (const bad of FORBIDDEN_DOMAINS) {
  if (siteUrl.includes(bad)) fail(`NEXT_PUBLIC_SITE_URL contains production domain '${bad}'`);
}
console.log(`  site    : ${siteUrl} (links + short domain)`);

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const sql = postgres(dbUrl!, { prepare: false, max: 1, connect_timeout: 20, onnotice: () => {} });

  try {
    // ── guard 2: foreign organization ───────────────────────────────────────
    const orgs = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM organizations ORDER BY created_at`;
    const foreign = orgs.filter((o) => o.name !== ORG_NAME && !o.name.startsWith("Demo"));

    console.log("\n=== ROW-COUNT SCOPE (pre-write) ===");
    const scope = await sql<{ t: string; n: number }[]>`
      SELECT 'organizations' t, count(*)::int n FROM organizations
      UNION ALL SELECT 'contacts', count(*)::int FROM contacts
      UNION ALL SELECT 'campaigns', count(*)::int FROM campaigns
      UNION ALL SELECT 'stage_sends', count(*)::int FROM stage_sends
      UNION ALL SELECT 'provider_credentials', count(*)::int FROM provider_credentials`;
    for (const r of scope) console.log(`  ${r.t.padEnd(22)} ${r.n}`);
    if (scope.length === 0) fail("scope query returned nothing — refusing to write blind");

    if (foreign.length > 0) {
      fail(
        `database contains ${foreign.length} organization(s) this script did not create:\n` +
          foreign.map((o) => `          - ${o.name}`).join("\n") +
          `\n        This is the prod-protection guard. Refusing to write.`,
      );
    }
    console.log("  guard   : PASS (no foreign organization)");

    if (DRY_RUN) {
      console.log("\n--dry-run: guards passed, no writes performed.");
      return;
    }

    // ── auth user (service-role admin API) ──────────────────────────────────
    // Must go through GoTrue, not a raw INSERT into auth.users: only the admin
    // API produces the identity row + password hash that make LOGIN actually
    // work. The on_auth_user_created trigger then creates the org + owner
    // membership, so the org is adopted here rather than inserted by us.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const email = process.env.TEST_USER_EMAIL;
    const password = process.env.TEST_USER_PASSWORD;
    if (!supabaseUrl || !serviceKey) fail("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required");
    if (!email || !password) fail("TEST_USER_EMAIL / TEST_USER_PASSWORD required");

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    console.log("\n=== AUTH USER ===");
    let userId: string;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // login must work without an inbox round-trip
      user_metadata: { display_name: "Demo User" },
    });

    if (createErr) {
      // Already present (re-run): look it up rather than failing.
      const { data: list, error: listErr } = await admin.auth.admin.listUsers();
      if (listErr) fail(`could not create or list users: ${createErr.message} / ${listErr.message}`);
      const existing = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (!existing) fail(`createUser failed and user not found: ${createErr.message}`);
      userId = existing.id;
      console.log(`  reused existing auth user  ${email}`);
      // Reset the password so the documented demo credentials always work.
      await admin.auth.admin.updateUserById(userId, { password, email_confirm: true });
      console.log(`  password reset to TEST_USER_PASSWORD`);
    } else {
      userId = created.user.id;
      console.log(`  created auth user          ${email}`);
    }

    // The trigger created an org named "<display_name>'s Organization".
    const memberships = await sql<{ org_id: string }[]>`
      SELECT org_id FROM org_members WHERE user_id = ${userId}::uuid LIMIT 1`;
    if (memberships.length === 0) fail("no org_members row for the demo user — signup trigger did not fire");
    const orgId = memberships[0]!.org_id;
    await sql`UPDATE organizations SET name = ${ORG_NAME} WHERE id = ${orgId}::uuid`;
    console.log(`  org                        ${orgId} ("${ORG_NAME}")`);

    // ── already-seeded check ────────────────────────────────────────────────
    const seeded = await sql<{ id: number }[]>`
      SELECT id FROM brands WHERE org_id = ${orgId}::uuid AND brand_id = ${BRAND_KEY} LIMIT 1`;
    if (seeded.length > 0) {
      console.log("\nAlready seeded (demo brand present) — nothing to do.");
      await printFinalScope(sql, orgId);
      return;
    }

    console.log("\n=== SEEDING ===");
    await sql.begin(async (tx) => {
      // sends OFF at the org level: the DB-backed master switch, independent of
      // the absent SEND_ENABLED env. Belt and braces.
      await tx`
        INSERT INTO org_settings (org_id, sends_enabled, sends_paused)
        VALUES (${orgId}::uuid, false, false)
        ON CONFLICT (org_id) DO UPDATE SET sends_enabled = false`;

      // registry -------------------------------------------------------------
      const [network] = await tx<{ id: number }[]>`
        INSERT INTO affiliate_networks (network_id, org_id, name, url, status)
        VALUES ('DEMO-NET', ${orgId}::uuid, 'Demo Network', ${siteUrl}, 'active')
        RETURNING id`;

      const [brand] = await tx<{ id: number }[]>`
        INSERT INTO brands (brand_id, org_id, name, short_link_base, website, status)
        VALUES (${BRAND_KEY}, ${orgId}::uuid, 'Demo Brand', ${shortDomain}, ${siteUrl}, 'active')
        RETURNING id`;

      const [domain] = await tx<{ id: number }[]>`
        INSERT INTO short_domains (org_id, brand_id, domain, status)
        VALUES (${orgId}::uuid, ${brand!.id}, ${shortDomain}, 'active')
        RETURNING id`;

      const offers: { id: number; name: string }[] = [];
      for (const [key, name] of [
        ["DEMO-OFF-1", "Demo Offer — Fitness"],
        ["DEMO-OFF-2", "Demo Offer — Finance"],
      ] as const) {
        const [o] = await tx<{ id: number; name: string }[]>`
          INSERT INTO offers (offer_id, org_id, name, network_id, base_url, payout_model, payout_cpa, status)
          VALUES (${key}, ${orgId}::uuid, ${name}, ${network!.id}, ${`${siteUrl}/lp/${key.toLowerCase()}`},
                  'cpa', 32.5000, 'active')
          RETURNING id, name`;
        offers.push(o!);
      }

      // Providers: NON-registry keys + supports_api_send=false + no credentials.
      const providers: { id: number; name: string }[] = [];
      for (const [key, name] of [
        ["demo-a", "Demo SMS Co"],
        ["demo-b", "Demo Routes"],
        ["demo-c", "Demo Messaging"],
      ] as const) {
        const [p] = await tx<{ id: number; name: string }[]>`
          INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send, status)
          VALUES (${key}, ${orgId}::uuid, ${name}, false, 'active')
          RETURNING id, name`;
        providers.push(p!);
      }

      const phones: { id: number; phone_number: string }[] = [];
      for (let i = 0; i < providers.length; i++) {
        const number = `+1555${String(9000000 + i).slice(-7)}`;
        const [ph] = await tx<{ id: number; phone_number: string }[]>`
          INSERT INTO provider_phones (org_id, provider_id, brand_id, phone_number, country_code,
                                       dial_code, local_number, cost_per_sms, number_type, status)
          VALUES (${orgId}::uuid, ${providers[i]!.id}, ${brand!.id}, ${number}, 'US', '+1',
                  ${number.slice(2)}, 0.0075, 'long_code', 'active')
          RETURNING id, phone_number`;
        phones.push(ph!);
      }

      // creatives ------------------------------------------------------------
      const creativeTexts = [
        "Your Demo Brand trial is ready — see your plan here: {link} Reply STOP to opt out",
        "Last call: your Demo Brand offer expires tonight. {link} Reply STOP to opt out",
        "Quick question — did you finish signing up? {link} Reply STOP to opt out",
        "Demo Brand: members saved an average of 20% this month. {link} Reply STOP to opt out",
        "We held your spot for 24h. Claim it: {link} Reply STOP to opt out",
      ];
      const creatives: { id: number }[] = [];
      for (let i = 0; i < creativeTexts.length; i++) {
        const [c] = await tx<{ id: number }[]>`
          INSERT INTO creatives (slug, org_id, text, quality, sequence_placement, funnel_stage,
                                 applies_to_all_offers, status)
          VALUES (${`demo-creative-${i + 1}`}, ${orgId}::uuid, ${creativeTexts[i]!},
                  ${pick(["high", "average", "unknown"])},
                  ${pick(["1st", "2nd", "any"])},
                  ${pick(["start", "clicked", "unknown"])},
                  true, 'active')
          RETURNING id`;
        creatives.push(c!);
        await tx`
          INSERT INTO creative_offers (creative_id, offer_id, org_id)
          VALUES (${c!.id}, ${offers[i % offers.length]!.id}, ${orgId}::uuid)`;
      }

      // contact groups + contacts ---------------------------------------------
      const groups: { id: number; name: string }[] = [];
      for (const [key, name] of [
        ["DEMO-GRP-1", "Newsletter Signups"],
        ["DEMO-GRP-2", "Webinar Attendees"],
        ["DEMO-GRP-3", "Lapsed Customers"],
      ] as const) {
        const [g] = await tx<{ id: number; name: string }[]>`
          INSERT INTO contact_groups (contact_group_id, org_id, name, description, status)
          VALUES (${key}, ${orgId}::uuid, ${name}, ${`Synthetic demo group: ${name}`}, 'active')
          RETURNING id, name`;
        groups.push(g!);
      }

      const carriers = ["AT&T", "T-Mobile", "Verizon", "Other Mobile"] as const;
      const contactIds: string[] = [];
      const CHUNK = 100;
      for (let start = 0; start < CONTACT_COUNT; start += CHUNK) {
        const rows = [];
        for (let i = start; i < Math.min(start + CHUNK, CONTACT_COUNT); i++) {
          rows.push({
            org_id: orgId,
            phone_number: `+1555${String(1000000 + i).slice(-7)}`,
            line_type: "mobile",
            carrier_norm: pick(carriers),
            messaging_status: "eligible",
          });
        }
        // NOTE: postgres.js's bulk-insert helper and the tagged-template generic
        // don't compose (the helper widens the template's param type), so the
        // row type is asserted on the result instead of the tag.
        const inserted = (await tx`
          INSERT INTO contacts ${tx(rows, "org_id", "phone_number", "line_type", "carrier_norm", "messaging_status")}
          RETURNING id`) as unknown as { id: string }[];
        contactIds.push(...inserted.map((r) => r.id));
      }

      // Each contact lands in 1–2 groups.
      const groupRows: { contact_id: string; contact_group_id: number; org_id: string }[] = [];
      contactIds.forEach((cid, i) => {
        groupRows.push({ contact_id: cid, contact_group_id: groups[i % groups.length]!.id, org_id: orgId });
        if (rnd() < 0.3) {
          const alt = groups[(i + 1) % groups.length]!;
          groupRows.push({ contact_id: cid, contact_group_id: alt.id, org_id: orgId });
        }
      });
      for (let i = 0; i < groupRows.length; i += 200) {
        await tx`INSERT INTO contact_contact_groups ${tx(
          groupRows.slice(i, i + 200),
          "contact_id",
          "contact_group_id",
          "org_id",
        )} ON CONFLICT DO NOTHING`;
      }

      // segments (manual membership so the audience picker is non-empty) -------
      const segments: { id: number }[] = [];
      for (const [key, name, share] of [
        ["DEMO-SEG-1", "Engaged — last 30 days", 0.5],
        ["DEMO-SEG-2", "All demo contacts", 1.0],
      ] as const) {
        const [s] = await tx<{ id: number }[]>`
          INSERT INTO segments (org_id, segment_id, name, status)
          VALUES (${orgId}::uuid, ${key}, ${name}, 'active')
          RETURNING id`;
        segments.push(s!);
        const members = contactIds.filter((_, i) => i / contactIds.length < share);
        for (let i = 0; i < members.length; i += 200) {
          await tx`INSERT INTO segment_contacts ${tx(
            members.slice(i, i + 200).map((cid) => ({ segment_id: s!.id, contact_id: cid, org_id: orgId })),
            "segment_id",
            "contact_id",
            "org_id",
          )} ON CONFLICT DO NOTHING`;
        }
      }

      // campaigns --------------------------------------------------------------
      const now = new Date();
      const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000);
      const mmddyy = (d: Date) =>
        `${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}${String(
          d.getFullYear(),
        ).slice(-2)}`;

      const campaignSpecs = [
        { slug: "demo-draft", name: "Demo — Draft campaign", status: "draft", offer: 0, created: daysAgo(1) },
        { slug: "demo-scheduled", name: "Demo — Scheduled campaign", status: "active", offer: 1, created: daysAgo(2) },
        { slug: "demo-completed", name: "Demo — Completed campaign", status: "completed", offer: 0, created: daysAgo(7) },
      ] as const;

      const campaigns: { id: number; slug: string; tracking_id: string; status: string }[] = [];
      for (let i = 0; i < campaignSpecs.length; i++) {
        const spec = campaignSpecs[i]!;
        const trackingId = `${brand!.id}_${offers[spec.offer]!.id}_${mmddyy(spec.created)}_${i + 1}`;
        const [c] = await tx<{ id: number; slug: string; tracking_id: string; status: string }[]>`
          INSERT INTO campaigns (org_id, slug, name, human_id, brand_id, offer_id, status,
                                 audience_segment_ids, audience_contact_group_ids, link_mode,
                                 created_by_user_id, tracking_id, created_at, exclude_in_use_contacts)
          VALUES (${orgId}::uuid, ${spec.slug}, ${spec.name}, ${spec.slug.toUpperCase()},
                  ${brand!.id}, ${offers[spec.offer]!.id}, ${spec.status},
                  ${JSON.stringify([segments[0]!.id])}::jsonb, ${JSON.stringify([])}::jsonb, 'tracked',
                  ${userId}::uuid, ${trackingId}, ${spec.created}, false)
          RETURNING id, slug, tracking_id, status`;
        campaigns.push(c!);
      }

      // Stages: draft campaign -> one draft stage; scheduled -> one future
      // pending stage; completed -> two sent stages with full history.
      const draft = campaigns[0]!;
      const scheduled = campaigns[1]!;
      const completed = campaigns[2]!;

      await tx`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, label, creative_id,
                                     sms_provider_id, provider_phone_id, status, tracking_id, send_approved)
        VALUES (${orgId}::uuid, ${draft.id}, 1, 'Stage 1', ${creatives[0]!.id},
                ${providers[0]!.id}, ${phones[0]!.id}, 'draft',
                ${`${draft.tracking_id}_s1_c${creatives[0]!.id}`}, false)`;

      await tx`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, label, creative_id,
                                     sms_provider_id, provider_phone_id, status, scheduled_at,
                                     tracking_id, send_approved)
        VALUES (${orgId}::uuid, ${scheduled.id}, 1, 'Stage 1', ${creatives[1]!.id},
                ${providers[1]!.id}, ${phones[1]!.id}, 'pending',
                ${new Date(now.getTime() + 3 * 86400000)},
                ${`${scheduled.tracking_id}_s1_c${creatives[1]!.id}`}, false)`;

      // completed campaign: audience pool + two sent stages -------------------
      const audience = contactIds.slice(0, 320);
      for (let i = 0; i < audience.length; i += 200) {
        await tx`INSERT INTO campaign_audience_pool ${tx(
          audience.slice(i, i + 200).map((cid) => ({ campaign_id: completed.id, contact_id: cid, org_id: orgId })),
          "campaign_id",
          "contact_id",
          "org_id",
        )} ON CONFLICT DO NOTHING`;
      }

      const [destination] = await tx<{ id: number }[]>`
        INSERT INTO link_destinations (org_id, url, url_hash)
        VALUES (${orgId}::uuid, ${`${siteUrl}/lp/demo-off-1`},
                encode(sha256(${`${siteUrl}/lp/demo-off-1`}::bytea), 'hex'))
        RETURNING id`;

      let linkCounter = 0;
      for (let stageNo = 1; stageNo <= 2; stageNo++) {
        const creative = creatives[stageNo]!;
        const sentAt = daysAgo(7 - stageNo);
        const recipients = stageNo === 1 ? audience : audience.slice(0, 180);

        const [stage] = await tx<{ id: number }[]>`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, label, creative_id,
                                       sms_provider_id, provider_phone_id, status, sent_at,
                                       tracking_id, send_approved, sms_count, total_cost, materialized_at)
          VALUES (${orgId}::uuid, ${completed.id}, ${stageNo}, ${`Stage ${stageNo}`}, ${creative.id},
                  ${providers[0]!.id}, ${phones[0]!.id}, 'sent', ${sentAt},
                  ${`${completed.tracking_id}_s${stageNo}_c${creative.id}`}, true,
                  ${recipients.length}, ${(recipients.length * 0.0075).toFixed(4)}, ${sentAt})
          RETURNING id`;
        const stageId = stage!.id;
        const stageTracking = `${completed.tracking_id}_s${stageNo}_c${creative.id}`;

        // stage_sends
        const sendRows = recipients.map((cid, i) => ({
          org_id: orgId,
          campaign_id: completed.id,
          stage_id: stageId,
          contact_id: cid,
          phone: `+1555${String(1000000 + audience.indexOf(cid)).slice(-7)}`,
          rendered_text: creative.id ? creativeTexts[stageNo]! : "",
          status: "sent",
          sent_at: new Date(sentAt.getTime() + i * 1000),
          provider_phone_id: phones[0]!.id,
          cost_per_sms: 0.0075,
        }));
        const sends: { id: string; contact_id: string }[] = [];
        for (let i = 0; i < sendRows.length; i += 150) {
          const chunk = (await tx`
            INSERT INTO stage_sends ${tx(
              sendRows.slice(i, i + 150),
              "org_id",
              "campaign_id",
              "stage_id",
              "contact_id",
              "phone",
              "rendered_text",
              "status",
              "sent_at",
              "provider_phone_id",
              "cost_per_sms",
            )} RETURNING id, contact_id`) as unknown as { id: string; contact_id: string }[];
          sends.push(...chunk);
        }

        // links + clicks for ~22% of recipients, with realistic classifications
        const clickers = sends.filter(() => rnd() < 0.22);
        const linkRows = clickers.map((s) => ({
          org_id: orgId,
          code: `d${stageNo}${(linkCounter++).toString(36).padStart(5, "0")}`,
          short_domain_id: domain!.id,
          destination_id: destination!.id,
          campaign_id: completed.id,
          stage_id: stageId,
          creative_id: creative.id,
          contact_id: s.contact_id,
          send_token: s.id,
          campaign_tracking_id: completed.tracking_id,
          stage_tracking_id: stageTracking,
        }));
        const links: { id: string; contact_id: string }[] = [];
        for (let i = 0; i < linkRows.length; i += 150) {
          const chunk = (await tx`
            INSERT INTO links ${tx(
              linkRows.slice(i, i + 150),
              "org_id",
              "code",
              "short_domain_id",
              "destination_id",
              "campaign_id",
              "stage_id",
              "creative_id",
              "contact_id",
              "send_token",
              "campaign_tracking_id",
              "stage_tracking_id",
            )} RETURNING id, contact_id`) as unknown as { id: string; contact_id: string }[];
          links.push(...chunk);
        }

        // Classification mix drives EPC denominators and counted_clickers.
        const clickRows = links.map((l) => {
          const r = rnd();
          const classification = r < 0.72 ? "human" : r < 0.84 ? "suspect" : r < 0.94 ? "bot" : "prefetch";
          return {
            org_id: orgId,
            link_id: l.id,
            clicked_at: new Date(sentAt.getTime() + Math.floor(rnd() * 6 * 3600) * 1000),
            classification,
            user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) DemoSeed",
            ip: `203.0.113.${Math.floor(rnd() * 254) + 1}`, // TEST-NET-3, never routable
            bot_score: classification === "human" ? 5 : classification === "suspect" ? 45 : 85,
            scored_at: new Date(sentAt.getTime() + 7200000),
            seconds_since_send: Math.floor(rnd() * 21600),
          };
        });
        for (let i = 0; i < clickRows.length; i += 150) {
          await tx`INSERT INTO clicks ${tx(
            clickRows.slice(i, i + 150),
            "org_id",
            "link_id",
            "clicked_at",
            "classification",
            "user_agent",
            "ip",
            "bot_score",
            "scored_at",
            "seconds_since_send",
          )}`;
        }

        // counted_clickers: the human-click cache the EPC surfaces read.
        const humanLinks = links.filter((_, i) => clickRows[i]!.classification === "human");
        if (humanLinks.length > 0) {
          for (let i = 0; i < humanLinks.length; i += 150) {
            await tx`INSERT INTO counted_clickers ${tx(
              humanLinks.slice(i, i + 150).map((l, j) => ({
                org_id: orgId,
                campaign_id: completed.id,
                stage_id: stageId,
                creative_id: creative.id,
                contact_id: l.contact_id,
                first_click_at: clickRows[i + j]?.clicked_at ?? sentAt,
              })),
              "org_id",
              "campaign_id",
              "stage_id",
              "creative_id",
              "contact_id",
              "first_click_at",
            )} ON CONFLICT DO NOTHING`;
          }
          // clickers (engagement table) for the same contacts
          for (let i = 0; i < humanLinks.length; i += 150) {
            await tx`INSERT INTO clickers ${tx(
              humanLinks.slice(i, i + 150).map((l) => ({
                org_id: orgId,
                contact_id: l.contact_id,
                phone_number: `+1555${String(1000000 + audience.indexOf(l.contact_id)).slice(-7)}`,
                brand_id: brand!.id,
                offer_id: offers[0]!.id,
                provider_id: providers[0]!.id,
                provider_phone_id: phones[0]!.id,
                source: "demo_seed",
              })),
              "org_id",
              "contact_id",
              "phone_number",
              "brand_id",
              "offer_id",
              "provider_id",
              "provider_phone_id",
              "source",
            )} ON CONFLICT DO NOTHING`;
          }
        }

        // a few sales on stage 1 so revenue/EPC render
        if (stageNo === 1) {
          const buyers = sends.slice(0, 9).map((s) => s.id);
          await tx`
            UPDATE stage_sends
            SET sale_status = 'sale', sale_revenue = 32.5000, converted_at = ${new Date(sentAt.getTime() + 9e6)}
            WHERE id = ANY(${buyers}::uuid[])`;
        }

        // opt-outs (~1.4%) — the suppression + opt-out-rate surfaces
        const optOuts = sends.filter(() => rnd() < 0.014);
        if (optOuts.length > 0) {
          await tx`INSERT INTO opt_outs ${tx(
            optOuts.map((s) => ({
              org_id: orgId,
              contact_id: s.contact_id,
              phone_number: `+1555${String(1000000 + audience.indexOf(s.contact_id)).slice(-7)}`,
              source: "sms_inbound",
            })),
            "org_id",
            "contact_id",
            "phone_number",
            "source",
          )} ON CONFLICT DO NOTHING`;
          await tx`
            UPDATE campaign_stages SET opt_out_count = ${optOuts.length},
                                       click_count = ${links.length}
            WHERE id = ${stageId}`;
        }
      }
    });

    console.log("  seed committed.");
    await assertNoProdDomains(sql, orgId);
    await printFinalScope(sql, orgId);
  } finally {
    await sql.end();
  }
}

// ── guard 3 (dynamic half): no seeded row references a production domain ─────
async function assertNoProdDomains(sql: postgres.Sql, orgId: string) {
  console.log("\n=== DOMAIN GUARD (post-write) ===");
  for (const bad of FORBIDDEN_DOMAINS) {
    const hits = await sql<{ n: number }[]>`
      SELECT (
        (SELECT count(*) FROM link_destinations WHERE org_id = ${orgId}::uuid AND url ILIKE ${"%" + bad + "%"}) +
        (SELECT count(*) FROM short_domains    WHERE org_id = ${orgId}::uuid AND domain ILIKE ${"%" + bad + "%"}) +
        (SELECT count(*) FROM offers           WHERE org_id = ${orgId}::uuid AND coalesce(base_url,'') ILIKE ${"%" + bad + "%"}) +
        (SELECT count(*) FROM brands           WHERE org_id = ${orgId}::uuid AND coalesce(website,'') ILIKE ${"%" + bad + "%"}) +
        (SELECT count(*) FROM creatives        WHERE org_id = ${orgId}::uuid AND text ILIKE ${"%" + bad + "%"})
      )::int AS n`;
    const n = hits[0]!.n;
    console.log(`  ${bad.padEnd(12)} ${n} reference(s)`);
    if (n > 0) fail(`seeded data references production domain '${bad}'`);
  }
  console.log("  guard   : PASS (no production domains in seeded content)");
}

async function printFinalScope(sql: postgres.Sql, orgId: string) {
  console.log("\n=== ROW-COUNT SCOPE (post-write, demo org only) ===");
  const rows = await sql<{ t: string; n: number }[]>`
    SELECT 'contacts' t, count(*)::int n FROM contacts WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'contact_groups', count(*)::int FROM contact_groups WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'segments', count(*)::int FROM segments WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'sms_providers', count(*)::int FROM sms_providers WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'provider_credentials', count(*)::int FROM provider_credentials WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'creatives', count(*)::int FROM creatives WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'campaigns', count(*)::int FROM campaigns WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'campaign_stages', count(*)::int FROM campaign_stages WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'stage_sends', count(*)::int FROM stage_sends WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'links', count(*)::int FROM links WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'clicks', count(*)::int FROM clicks WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'counted_clickers', count(*)::int FROM counted_clickers WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'clickers', count(*)::int FROM clickers WHERE org_id = ${orgId}::uuid
    UNION ALL SELECT 'opt_outs', count(*)::int FROM opt_outs WHERE org_id = ${orgId}::uuid`;
  for (const r of rows) console.log(`  ${r.t.padEnd(22)} ${r.n}`);
  if (rows.every((r) => r.n === 0)) fail("post-write scope is entirely empty — seed did not land");
}

main().catch((e) => {
  console.error("\nSEED FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
