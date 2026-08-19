// Builds a deterministic staging dataset on an already-migrated database.
//
// Requires: SEED_TARGET=staging in env (production guard).
// Run:   npx tsx scripts/db-seed.ts
// Reset: npx tsx scripts/db-seed.ts --force  (drops seed org → re-seeds)
//
// What gets created:
//   • 1 auth user  seed@camman-staging.local  (trigger creates org + member)
//   • 1 affiliate network, 1 brand, 1 offer
//   • 1 SMS provider + 1 provider phone
//   • 5 creatives (creative 5 allows multi-segment so that UI path is exercisable)
//   • 1 contact group with the first 100 contacts assigned
//   • 500 contacts — generated +1555 numbers, no real data
//   • 3 campaigns: completed (2 sent stages + 500 stage_sends), active, draft
//   • report_stage_hour + report_group_hour: 14 days × 2 stages (seeds the
//     rollup tables so report charts render instead of showing empty state)

import "./_env-preload";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

// ─── Production guard ────────────────────────────────────────────────────────
if (process.env.SEED_TARGET !== "staging") {
  console.error(
    "SEED REFUSED: SEED_TARGET=staging is not set.\n" +
      "  Add it to .env.local for the staging database to allow this script.\n" +
      "  This guard prevents accidental execution against production data.",
  );
  process.exit(1);
}

// ─── Config ──────────────────────────────────────────────────────────────────
const SEED_EMAIL = "seed@camman-staging.local";
const SEED_PASS = "SeedPass123!";
const CONTACT_COUNT = 500;
const POOL_BATCH = 100;
const isForce = process.argv.includes("--force");

// ─── Clients ─────────────────────────────────────────────────────────────────
for (const [k, v] of [
  ["NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL],
  ["SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY],
  ["DATABASE_URL", process.env.DATABASE_URL],
] as const) {
  if (!v) { console.error(`${k} must be set`); process.exit(1); }
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

function log(msg: string) { console.log(msg); }
function daysAgo(n: number) { return new Date(Date.now() - n * 86_400_000); }

// ─── Phone number helpers ────────────────────────────────────────────────────
// +1555XXXXXXX — NANPA 555 range is reserved for fictional use.
function seedPhone(seq: number) {
  return `+1555${String(seq).padStart(7, "0")}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // ── 1. Auth user + org ──────────────────────────────────────────────────
  log("► Checking seed user...");

  // Query auth.users directly (service-role connection has access to auth schema).
  const existingAuth = await pg`
    SELECT id FROM auth.users WHERE email = ${SEED_EMAIL} LIMIT 1
  `;
  let userId = existingAuth[0]?.id as string | undefined;

  if (userId) {
    const orgRow = await pg`
      SELECT org_id FROM org_members WHERE user_id = ${userId} LIMIT 1
    `;
    const orgId = orgRow[0]?.org_id as string | undefined;

    if (!isForce) {
      // Check if the seed data is already there.
      const brandRow = orgId
        ? await pg`SELECT id FROM brands WHERE org_id = ${orgId} LIMIT 1`
        : [];
      if (brandRow.length > 0) {
        log(`  → Already seeded (org_id: ${orgId}).`);
        log(`  → Re-run with --force to wipe and rebuild, or run db:reset.`);
        return;
      }
    }

    if (isForce && orgId) {
      log("  → --force: deleting seed org (CASCADE wipes all org data)...");
      await pg`DELETE FROM organizations WHERE id = ${orgId}`;
    }
    if (isForce) {
      log("  → --force: deleting seed auth user...");
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw error;
      userId = undefined;
    }
  }

  if (!userId) {
    log("  → Creating seed auth user...");
    const { data, error } = await admin.auth.admin.createUser({
      email: SEED_EMAIL,
      password: SEED_PASS,
      email_confirm: true,
      user_metadata: { display_name: "Seed User" },
    });
    if (error || !data.user) throw error ?? new Error("createUser returned no user");
    userId = data.user.id;
    log(`  ✓ Created auth user: ${userId}`);
  }

  // Get org_id from the trigger-created membership row.
  const orgRow = await pg`
    SELECT org_id FROM org_members WHERE user_id = ${userId} LIMIT 1
  `;
  if (!orgRow[0]) throw new Error("org_members row not found for seed user");
  const orgId = orgRow[0].org_id as string;

  await pg`UPDATE organizations SET name = 'Seed Org' WHERE id = ${orgId}`;
  log(`  ✓ Org: ${orgId}`);

  // ── 2. Registry ─────────────────────────────────────────────────────────
  log("► Seeding registry...");

  const [network] = await pg`
    INSERT INTO affiliate_networks (org_id, network_id, name)
    VALUES (${orgId}, 'seed-net-v1', 'Seed Network')
    ON CONFLICT (network_id) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  const [brand] = await pg`
    INSERT INTO brands (org_id, brand_id, name)
    VALUES (${orgId}, 'seed-brand-v1', 'Seed Brand')
    ON CONFLICT (brand_id) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  const [offer] = await pg`
    INSERT INTO offers (org_id, offer_id, name, network_id, payout_model, payout_cpa)
    VALUES (${orgId}, 'seed-offer-v1', 'Seed Offer', ${network.id as number}, 'cpa', 15.0000)
    ON CONFLICT (offer_id) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  const [provider] = await pg`
    INSERT INTO sms_providers (
      org_id, sms_provider_id, name, supports_api_send,
      send_window_weekday_start, send_window_weekday_end,
      send_window_weekend_start, send_window_weekend_end
    )
    VALUES (${orgId}, 'seed-prov-v1', 'Seed Provider', false, 480, 1260, 480, 1260)
    ON CONFLICT (sms_provider_id) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  const [phone] = await pg`
    INSERT INTO provider_phones (org_id, provider_id, phone_number, number_type, cost_per_sms)
    VALUES (${orgId}, ${provider.id as number}, '+15559998888', '10dlc', 0.0085)
    ON CONFLICT (org_id, phone_number) DO UPDATE SET cost_per_sms = EXCLUDED.cost_per_sms
    RETURNING id
  `;
  await pg`
    INSERT INTO org_settings (org_id, sends_enabled)
    VALUES (${orgId}, false)
    ON CONFLICT (org_id) DO NOTHING
  `;

  log(`  ✓ Network #${network.id}, brand #${brand.id}, offer #${offer.id}, provider #${provider.id}, phone #${phone.id}`);

  // ── 3. Creatives ─────────────────────────────────────────────────────────
  log("► Seeding creatives...");

  const creativeDefs = [
    { slug: "seed-cr-1", text: "Hey! Check out this amazing deal just for you. Limited-time offer — act now.", multi: false },
    { slug: "seed-cr-2", text: "Exclusive savings only for our members. Grab this deal before it expires today!", multi: false },
    { slug: "seed-cr-3", text: "Don't miss out on our biggest sale of the season. Click to see your discount!", multi: false },
    { slug: "seed-cr-4", text: "You've been selected for our best rate. Reply YES to claim your special offer.", multi: false },
    {
      slug: "seed-cr-5",
      // Intentionally > 160 chars to exercise the multi-segment rendering path.
      text: "This is the Seed Org multi-segment creative. It exceeds 160 characters deliberately so staging reviewers can exercise the multi-segment SMS UI and confirm it renders correctly end-to-end.",
      multi: true,
    },
  ];

  const creativeIds: number[] = [];
  for (const cr of creativeDefs) {
    const [row] = await pg`
      INSERT INTO creatives (org_id, slug, text, quality, sequence_placement, funnel_stage, allow_multi_segment)
      VALUES (${orgId}, ${cr.slug}, ${cr.text}, 'unknown', 'unknown', 'unknown', ${cr.multi})
      ON CONFLICT (slug) DO UPDATE SET text = EXCLUDED.text, allow_multi_segment = EXCLUDED.allow_multi_segment
      RETURNING id
    `;
    creativeIds.push(row.id as number);
  }
  for (const cid of creativeIds.slice(0, 4)) {
    await pg`
      INSERT INTO creative_offers (creative_id, offer_id, org_id)
      VALUES (${cid}, ${offer.id as number}, ${orgId})
      ON CONFLICT (creative_id, offer_id) DO NOTHING
    `;
  }
  log(`  ✓ ${creativeIds.length} creatives (creative 5 allows multi-segment)`);

  // ── 4. Contact group ─────────────────────────────────────────────────────
  log("► Seeding contact group...");
  const [cgroup] = await pg`
    INSERT INTO contact_groups (org_id, contact_group_id, name)
    VALUES (${orgId}, 'seed-cg-v1', 'Seed Group')
    ON CONFLICT (contact_group_id) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  log(`  ✓ Contact group #${cgroup.id}`);

  // ── 5. Contacts (500 generated phones) ──────────────────────────────────
  log(`► Seeding ${CONTACT_COUNT} contacts...`);

  const contactIds: string[] = [];
  for (let start = 0; start < CONTACT_COUNT; start += POOL_BATCH) {
    const slice = Array.from({ length: Math.min(POOL_BATCH, CONTACT_COUNT - start) }, (_, i) => ({
      org_id: orgId,
      phone_number: seedPhone(start + i + 1),
    }));
    const inserted = await pg`
      INSERT INTO contacts ${pg(slice, "org_id", "phone_number")}
      ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = NOW()
      RETURNING id
    `;
    contactIds.push(...inserted.map((r) => r.id as string));
  }
  log(`  ✓ ${contactIds.length} contacts`);

  // Assign first 100 contacts to the seed group.
  const groupSlice = contactIds.slice(0, 100).map((cid) => ({
    contact_id: cid,
    contact_group_id: cgroup.id as number,
    org_id: orgId,
  }));
  await pg`
    INSERT INTO contact_contact_groups ${pg(groupSlice, "contact_id", "contact_group_id", "org_id")}
    ON CONFLICT (contact_id, contact_group_id) DO NOTHING
  `;
  log(`  ✓ First 100 contacts assigned to seed group`);

  // ── 6. Campaigns ─────────────────────────────────────────────────────────
  log("► Seeding campaigns...");

  const [campCompleted] = await pg`
    INSERT INTO campaigns (
      org_id, slug, name, brand_id, offer_id, status,
      audience_snapshot_count, link_mode, status_changed_at
    ) VALUES (
      ${orgId}, 'seed-camp-completed', 'Seed Campaign — Completed',
      ${brand.id as number}, ${offer.id as number}, 'completed',
      ${CONTACT_COUNT}, 'manual', ${daysAgo(7).toISOString()}
    )
    ON CONFLICT (org_id, slug) DO UPDATE SET status = EXCLUDED.status
    RETURNING id
  `;
  const [campActive] = await pg`
    INSERT INTO campaigns (
      org_id, slug, name, brand_id, offer_id, status,
      audience_snapshot_count, link_mode, status_changed_at
    ) VALUES (
      ${orgId}, 'seed-camp-active', 'Seed Campaign — Active',
      ${brand.id as number}, ${offer.id as number}, 'active',
      100, 'manual', ${daysAgo(1).toISOString()}
    )
    ON CONFLICT (org_id, slug) DO UPDATE SET status = EXCLUDED.status
    RETURNING id
  `;
  const [campDraft] = await pg`
    INSERT INTO campaigns (org_id, slug, name, status, link_mode)
    VALUES (${orgId}, 'seed-camp-draft', 'Seed Campaign — Draft', 'draft', 'manual')
    ON CONFLICT (org_id, slug) DO UPDATE SET status = EXCLUDED.status
    RETURNING id
  `;

  const [cCId, cAId, cDId] = [campCompleted.id, campActive.id, campDraft.id] as number[];
  log(`  ✓ Campaigns: completed=#${cCId}, active=#${cAId}, draft=#${cDId}`);

  // ── 7. Stages ────────────────────────────────────────────────────────────
  log("► Seeding stages...");

  const pId = provider.id as number;
  const phId = phone.id as number;

  const [stage1] = await pg`
    INSERT INTO campaign_stages (
      org_id, campaign_id, stage_number, creative_id,
      sms_provider_id, provider_phone_id, status,
      sms_count, send_approved, materialized_at, sent_at
    ) VALUES (
      ${orgId}, ${cCId}, 1, ${creativeIds[0]},
      ${pId}, ${phId}, 'sent',
      300, true,
      ${daysAgo(8).toISOString()}, ${daysAgo(8).toISOString()}
    )
    ON CONFLICT (campaign_id, stage_number) DO UPDATE SET status = EXCLUDED.status
    RETURNING id
  `;
  // Stage 2 uses the multi-segment creative so that path is exercised.
  const [stage2] = await pg`
    INSERT INTO campaign_stages (
      org_id, campaign_id, stage_number, creative_id,
      sms_provider_id, provider_phone_id, status,
      sms_count, send_approved, materialized_at, sent_at
    ) VALUES (
      ${orgId}, ${cCId}, 2, ${creativeIds[4]},
      ${pId}, ${phId}, 'sent',
      200, true,
      ${daysAgo(7).toISOString()}, ${daysAgo(7).toISOString()}
    )
    ON CONFLICT (campaign_id, stage_number) DO UPDATE SET status = EXCLUDED.status
    RETURNING id
  `;
  const [stage3] = await pg`
    INSERT INTO campaign_stages (org_id, campaign_id, stage_number, creative_id, sms_provider_id, provider_phone_id, status)
    VALUES (${orgId}, ${cAId}, 1, ${creativeIds[2]}, ${pId}, ${phId}, 'draft')
    ON CONFLICT (campaign_id, stage_number) DO UPDATE SET status = EXCLUDED.status
    RETURNING id
  `;
  const [stage4] = await pg`
    INSERT INTO campaign_stages (org_id, campaign_id, stage_number, status)
    VALUES (${orgId}, ${cDId}, 1, 'draft')
    ON CONFLICT (campaign_id, stage_number) DO UPDATE SET status = EXCLUDED.status
    RETURNING id
  `;

  const [s1Id, s2Id] = [stage1.id, stage2.id] as number[];
  log(`  ✓ Stages: s1=#${s1Id}, s2=#${s2Id}, s3=#${stage3.id}, s4=#${stage4.id}`);

  // ── 8. Audience pools ────────────────────────────────────────────────────
  log("► Seeding audience pools...");

  // Completed campaign: all 500 contacts.
  for (let i = 0; i < contactIds.length; i += POOL_BATCH) {
    const slice = contactIds.slice(i, i + POOL_BATCH).map((cid) => ({
      campaign_id: cCId,
      contact_id: cid,
      org_id: orgId,
    }));
    await pg`
      INSERT INTO campaign_audience_pool ${pg(slice, "campaign_id", "contact_id", "org_id")}
      ON CONFLICT (campaign_id, contact_id) DO NOTHING
    `;
  }

  // Active campaign: first 100 contacts.
  const activeSlice = contactIds.slice(0, 100).map((cid) => ({
    campaign_id: cAId,
    contact_id: cid,
    org_id: orgId,
  }));
  await pg`
    INSERT INTO campaign_audience_pool ${pg(activeSlice, "campaign_id", "contact_id", "org_id")}
    ON CONFLICT (campaign_id, contact_id) DO NOTHING
  `;
  log(`  ✓ Pools: ${CONTACT_COUNT} (completed), 100 (active)`);

  // ── 9. Stage sends (500 total: 300 for stage 1, 200 for stage 2) ─────────
  log("► Seeding stage_sends...");

  const s1Contacts = contactIds.slice(0, 300);
  const s2Contacts = contactIds.slice(300, 500);
  const s1SentAt = daysAgo(8).toISOString();
  const s2SentAt = daysAgo(7).toISOString();
  const renderedS1 = "Hey! Check out this amazing deal just for you. Limited-time offer — act now.\nStop to END";
  // Stage 2 uses the long multi-segment creative.
  const renderedS2 = "This is the Seed Org multi-segment creative. It exceeds 160 characters deliberately so staging reviewers can exercise the multi-segment SMS UI and confirm it renders correctly end-to-end.\nStop to END";

  for (let i = 0; i < s1Contacts.length; i += POOL_BATCH) {
    const slice = s1Contacts.slice(i, i + POOL_BATCH).map((cid, j) => ({
      org_id: orgId,
      campaign_id: cCId,
      stage_id: s1Id,
      contact_id: cid,
      phone: seedPhone(i + j + 1),
      rendered_text: renderedS1,
      status: "sent",
      sent_at: s1SentAt,
      provider_phone_id: phId,
      cost_per_sms: "0.0085",
    }));
    await pg`
      INSERT INTO stage_sends ${pg(slice, "org_id", "campaign_id", "stage_id", "contact_id", "phone", "rendered_text", "status", "sent_at", "provider_phone_id", "cost_per_sms")}
    `;
  }

  for (let i = 0; i < s2Contacts.length; i += POOL_BATCH) {
    const slice = s2Contacts.slice(i, i + POOL_BATCH).map((cid, j) => ({
      org_id: orgId,
      campaign_id: cCId,
      stage_id: s2Id,
      contact_id: cid,
      phone: seedPhone(300 + i + j + 1),
      rendered_text: renderedS2,
      status: "sent",
      sent_at: s2SentAt,
      provider_phone_id: phId,
      cost_per_sms: "0.0085",
    }));
    await pg`
      INSERT INTO stage_sends ${pg(slice, "org_id", "campaign_id", "stage_id", "contact_id", "phone", "rendered_text", "status", "sent_at", "provider_phone_id", "cost_per_sms")}
    `;
  }
  log(`  ✓ 300 stage_sends for stage 1, 200 for stage 2`);

  // ── 10. Report tables (report_stage_hour + report_group_hour) ────────────
  // 14 daily buckets (noon ET) for each of the 2 sent stages so the report
  // charts render data instead of an empty state.
  log("► Seeding report_stage_hour and report_group_hour...");

  for (const [stageId, campId, dailySent] of [
    [s1Id, cCId, 22], // 300 / ~14 ≈ 22/day
    [s2Id, cCId, 15], // 200 / ~14 ≈ 15/day
  ] as [number, number, number][]) {
    await pg`
      INSERT INTO report_stage_hour (
        org_id, stage_id, campaign_id,
        bucket_start_utc, bucket_date_et, bucket_hour_et,
        offer_id, brand_id, sms_provider_id,
        sent_count, cost, settled
      )
      SELECT
        ${orgId}::uuid,
        ${stageId}::int,
        ${campId}::int,
        -- noon ET → UTC (AT TIME ZONE on a timestamp-without-tz interprets it
        -- as local ET and returns a timestamptz stored as UTC internally)
        (d::timestamp + interval '12 hours') AT TIME ZONE 'America/New_York',
        to_char(d::date, 'YYYY-MM-DD'),
        12::smallint,
        ${offer.id as number}::int,
        ${brand.id as number}::int,
        ${pId}::int,
        ${dailySent}::int,
        (${dailySent} * 0.0085)::numeric(12,4),
        true
      FROM generate_series(
        (now() AT TIME ZONE 'America/New_York')::date - interval '14 days',
        (now() AT TIME ZONE 'America/New_York')::date - interval '1 day',
        interval '1 day'
      ) AS g(d)
      ON CONFLICT (org_id, stage_id, bucket_start_utc) DO NOTHING
    `;

    await pg`
      INSERT INTO report_group_hour (
        org_id, contact_group_id, stage_id, campaign_id,
        bucket_start_utc, bucket_date_et, bucket_hour_et,
        offer_id, brand_id, sms_provider_id,
        sent_count, cost, settled
      )
      SELECT
        ${orgId}::uuid,
        ${cgroup.id as number}::int,
        ${stageId}::int,
        ${campId}::int,
        (d + interval '12 hours') AT TIME ZONE 'America/New_York' AT TIME ZONE 'UTC',
        to_char(d::date, 'YYYY-MM-DD'),
        12::smallint,
        ${offer.id as number}::int,
        ${brand.id as number}::int,
        ${pId}::int,
        ${Math.round(dailySent * 0.2)}::int,
        (${Math.round(dailySent * 0.2)} * 0.0085)::numeric(12,4),
        true
      FROM generate_series(
        (now() AT TIME ZONE 'America/New_York')::date - interval '14 days',
        (now() AT TIME ZONE 'America/New_York')::date - interval '1 day',
        interval '1 day'
      ) AS g(d)
      ON CONFLICT (org_id, contact_group_id, stage_id, bucket_start_utc) DO NOTHING
    `;
  }
  log(`  ✓ 28 report_stage_hour rows, 28 report_group_hour rows`);

  // ── Done ──────────────────────────────────────────────────────────────────
  log("\n✓ Seed complete.");
  log(`  Org:      Seed Org  (${orgId})`);
  log(`  Login:    ${SEED_EMAIL}  /  ${SEED_PASS}`);
  log(`  Contacts: ${contactIds.length}`);
  log(`  Sends:    500 (stage 1: 300, stage 2: 200)`);
}

main()
  .catch((err) => { console.error("Seed failed:", err); process.exit(1); })
  .finally(() => pg.end({ timeout: 5 }));
