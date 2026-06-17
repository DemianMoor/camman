import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  clickers,
  contact_contact_groups,
  contact_groups,
  contacts,
  opt_out_brands,
  opt_outs,
  segments,
} from "../db/schema";

// Segment-rules test suite — UNION semantics (Model C).
//
// Fixtures are split into "manual" (uploaded to the segment) vs "external"
// (only in the contacts table) so the UNION path can be exercised: a rule
// can pull in contacts that aren't manual members, and a rule whose matches
// fall entirely inside the manual set is a no-op (audience = manual).

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  const dbUrl = process.env.DATABASE_URL!;
  const testEmail = process.env.TEST_USER_EMAIL;
  const testPassword = process.env.TEST_USER_PASSWORD;
  if (!testEmail || !testPassword) {
    console.error("Set TEST_USER_EMAIL/TEST_USER_PASSWORD in .env.local.");
    process.exit(1);
  }

  const cookieJar = new Map<string, string>();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () =>
        Array.from(cookieJar.entries()).map(([name, value]) => ({
          name,
          value,
        })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) cookieJar.set(name, value);
      },
    },
  });

  console.log(`Signing in as ${testEmail}…`);
  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email: testEmail,
    password: testPassword,
  });
  if (signInErr) {
    console.error(`Sign-in failed: ${signInErr.message}`);
    process.exit(1);
  }

  function cookieHeader() {
    return Array.from(cookieJar.entries())
      .map(([n, v]) => `${n}=${v}`)
      .join("; ");
  }
  async function apiFetch(path: string, init?: RequestInit) {
    return fetch(`${appUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
        Cookie: cookieHeader(),
      },
    });
  }

  let passed = 0;
  let failed = 0;
  function check(name: string, condition: boolean, detail?: string) {
    if (condition) {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      passed++;
    } else {
      console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
      failed++;
    }
  }

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);
  const unique = Date.now();

  // Phone-number ranges. Manual contacts live in 213-700-XXXX, external in
  // 213-800-XXXX. Indexes 0..4 / 0..6. Each run shifts by `base` to keep
  // contacts unique across concurrent runs.
  const base = (Number(String(unique).slice(-6)) % 9_000) + 1_000;
  const manualPhones = [0, 1, 2, 3, 4].map(
    (i) => `+1213700${String(base + i).padStart(4, "0")}`,
  );
  const externalPhones = [0, 1, 2, 3, 4, 5, 6].map(
    (i) => `+1213800${String(base + i).padStart(4, "0")}`,
  );

  const createdSegmentIds: number[] = [];
  const createdBrandIds: number[] = [];
  const createdGroupIds: number[] = [];
  const createdOfferIds: number[] = [];
  const createdNetworkIds: number[] = [];
  const insertedPhones: string[] = [...manualPhones, ...externalPhones];
  let orgId = "";
  let probeBrandId = 0;
  let otherBrandId = 0;
  let contactGroupId = 0;
  let testNetworkId = 0;

  try {
    const probeR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: `Rules Probe ${unique}`,
        brand_id: `PROBE-RULES-${unique}`,
      }),
    });
    if (probeR.status !== 201) {
      console.error("Couldn't create probe brand", await probeR.text());
      process.exit(1);
    }
    const probe = (await probeR.json()) as { id: number; org_id: string };
    orgId = probe.org_id;
    probeBrandId = probe.id;
    createdBrandIds.push(probe.id);

    // Networks are now required on offers, so set one up for the offer
    // fixture that the R2 rule uses below.
    const netR = await apiFetch("/api/networks", {
      method: "POST",
      body: JSON.stringify({
        name: `Rules Network ${unique}`,
        network_id: `RULES-N-${unique}`,
      }),
    });
    if (netR.status !== 201) {
      console.error("Couldn't create network", await netR.text());
      process.exit(1);
    }
    testNetworkId = ((await netR.json()) as { id: number }).id;
    createdNetworkIds.push(testNetworkId);

    const otherR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: `Rules Other ${unique}`,
        brand_id: `OTHER-RULES-${unique}`,
      }),
    });
    const other = (await otherR.json()) as { id: number };
    otherBrandId = other.id;
    createdBrandIds.push(other.id);

    const grpR = await apiFetch("/api/contact-groups", {
      method: "POST",
      body: JSON.stringify({
        name: `Rules Group ${unique}`,
        contact_group_id: `RULES-G-${unique}`,
      }),
    });
    const grp = (await grpR.json()) as { id: number };
    contactGroupId = grp.id;
    createdGroupIds.push(grp.id);

    console.log("\n[setup] Create segment + upload 5 manual contacts");
    const segR = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `Rules Seg ${unique}`,
        segment_id: `SEGR-${unique}`,
      }),
    });
    check("segment creation returns 201", segR.status === 201);
    const seg = (await segR.json()) as { id: number };
    createdSegmentIds.push(seg.id);

    const upR = await apiFetch(`/api/segments/${seg.id}/contacts/upload`, {
      method: "POST",
      body: JSON.stringify({ phones: manualPhones.join("\n") }),
    });
    check("manual upload returns 201", upR.status === 201);

    // Also create the external contacts in the org (without segment membership).
    // Inserted directly: the /api/contacts/upload endpoint now requires a
    // contact group (assign_to_group_ids), and tagging these into a group
    // would skew the group-membership fixture math below. A bare insert keeps
    // them org-members-only — same approach as the backdated R5 fixtures.
    for (const p of externalPhones) {
      await db.execute(drizzleSql`
        INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
        VALUES (${orgId}::uuid, ${p}, now(), now())
        ON CONFLICT DO NOTHING
      `);
    }
    check("external contacts inserted", true);

    // Resolve contact_ids for both sets so we can seed engagement directly.
    const allRows = await db
      .select({ id: contacts.id, phone_number: contacts.phone_number })
      .from(contacts)
      .where(
        inArray(contacts.phone_number, [...manualPhones, ...externalPhones]),
      );
    const idByPhone = new Map<string, string>();
    for (const r of allRows) idByPhone.set(r.phone_number, r.id);
    if (idByPhone.size !== manualPhones.length + externalPhones.length) {
      throw new Error(
        `expected ${manualPhones.length + externalPhones.length} contacts, found ${idByPhone.size}. Verify phone format is valid for libphonenumber.`,
      );
    }

    // Clicker fixture for probeBrand: manual[0..1] + external[0..4] = 7
    // distinct clickers. Of those, 2 are in the manual set (so the UNION
    // gains 5 external when the rule is added).
    const probeClickerPhones = [
      manualPhones[0],
      manualPhones[1],
      externalPhones[0],
      externalPhones[1],
      externalPhones[2],
      externalPhones[3],
      externalPhones[4],
    ];
    await db.insert(clickers).values(
      probeClickerPhones.map((p) => ({
        org_id: orgId,
        contact_id: idByPhone.get(p)!,
        phone_number: p,
        brand_id: probeBrandId,
        source: "test",
      })),
    );

    // Contact-group fixture: tag manual[0] + external[2..5] = 5 distinct.
    // Overlap with probeClickers: manual[0] (1) + external[2..4] (3) = 4 in
    // probeBrand-clicker ∩ group. external[5] is in the group only.
    const groupMemberPhones = [
      manualPhones[0],
      externalPhones[2],
      externalPhones[3],
      externalPhones[4],
      externalPhones[5],
    ];
    await db.insert(contact_contact_groups).values(
      groupMemberPhones.map((p) => ({
        org_id: orgId,
        contact_id: idByPhone.get(p)!,
        contact_group_id: contactGroupId,
      })),
    );

    console.log("\n[1] Empty rules → preview = manual_count = 5 (short-circuit)");
    const empty1R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    check("preview returns 200", empty1R.status === 200);
    const empty1 = (await empty1R.json()) as {
      count: number | null;
      manual_count: number;
      rule_filtered_count: number | null;
      truncated: boolean;
    };
    check(
      "zero-rule short-circuit: count = 5 = manual_count",
      empty1.count === 5 && empty1.manual_count === 5,
      `got count=${empty1.count} manual=${empty1.manual_count}`,
    );
    check(
      "rule_filtered_count = 5 (manual short-circuit)",
      empty1.rule_filtered_count === 5,
      `got ${empty1.rule_filtered_count}`,
    );

    console.log("\n[2] Rules list empty");
    const list0R = await apiFetch(`/api/segments/${seg.id}/rules`);
    const list0 = (await list0R.json()) as { data: unknown[] };
    check("rules list empty", list0.data.length === 0);

    console.log("\n[3] Add rule `is_clicker_for_brand: probeBrand`");
    // Bounded rule (specific brand) so the rule_match scan is small.
    const create1R = await apiFetch(`/api/segments/${seg.id}/rules`, {
      method: "POST",
      body: JSON.stringify({
        rule_type: "is_clicker_for_brand",
        operator: "is",
        value: probeBrandId,
        is_active: true,
      }),
    });
    check("rule create returns 201", create1R.status === 201);
    const rule1 = (await create1R.json()) as {
      id: number;
      position: number;
      rule_type: string;
    };
    check("rule.position = 1", rule1.position === 1);

    console.log("\n[4] UNION: manual(5) ∪ probeClickers(7, 2 overlap) = 10");
    const prev4R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const prev4 = (await prev4R.json()) as { count: number | null };
    check(
      "count = 10 (5 manual + 5 external clickers, 2 shared)",
      prev4.count === 10,
      `got ${prev4.count}`,
    );

    console.log("\n[5] is_active=false disables rule → back to manual (5)");
    const patch1R = await apiFetch(
      `/api/segments/${seg.id}/rules/${rule1.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ is_active: false }),
      },
    );
    check("PATCH is_active returns 200", patch1R.status === 200);
    const prev5R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const prev5 = (await prev5R.json()) as { count: number | null };
    check(
      "inactive rule → short-circuit to manual = 5",
      prev5.count === 5,
      `got ${prev5.count}`,
    );

    // Re-enable for the next steps.
    await apiFetch(`/api/segments/${seg.id}/rules/${rule1.id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: true }),
    });

    console.log(
      "\n[6] Add 2nd rule `is_in_contact_group` — AND between rules narrows rule_matches, UNION with manual still expands",
    );
    // rule1 (clicker_for_probe) AND rule2 (in group) matches contacts who
    // are BOTH. Overlap: manual[0] + external[2..4] = 4 contacts.
    // UNION with manual (5): manual[0] is in both sets; the 3 external
    // add new rows. Total = 5 manual + 3 external = 8.
    const create2R = await apiFetch(`/api/segments/${seg.id}/rules`, {
      method: "POST",
      body: JSON.stringify({
        rule_type: "is_in_contact_group",
        operator: "is",
        value: contactGroupId,
        is_active: true,
      }),
    });
    check("rule 2 create returns 201", create2R.status === 201);
    const rule2 = (await create2R.json()) as { id: number };
    const prev6R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const prev6 = (await prev6R.json()) as { count: number | null };
    check(
      "compound rule_matches (4 contacts) ∪ manual (5) = 8",
      prev6.count === 8,
      `got ${prev6.count}`,
    );

    console.log("\n[7] Add 3rd rule using otherBrand (no clickers) — rule_matches collapses to 0, UNION = manual (5)");
    const create3R = await apiFetch(`/api/segments/${seg.id}/rules`, {
      method: "POST",
      body: JSON.stringify({
        rule_type: "is_clicker_for_brand",
        operator: "is",
        value: otherBrandId,
        is_active: true,
      }),
    });
    check("rule 3 create returns 201", create3R.status === 201);
    const rule3 = (await create3R.json()) as { id: number };
    const prev7R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const prev7 = (await prev7R.json()) as { count: number | null };
    check(
      "empty rule_match ∪ manual = 5",
      prev7.count === 5,
      `got ${prev7.count}`,
    );

    console.log("\n[8] Reorder rules — count unchanged");
    const reorderR = await apiFetch(
      `/api/segments/${seg.id}/rules/reorder`,
      {
        method: "POST",
        body: JSON.stringify({ rule_ids: [rule3.id, rule1.id, rule2.id] }),
      },
    );
    check("reorder returns 200", reorderR.status === 200);
    const prev8R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const prev8 = (await prev8R.json()) as { count: number | null };
    check(
      "count unchanged after reorder",
      prev8.count === 5,
      `got ${prev8.count}`,
    );

    console.log("\n[9] Delete the otherBrand rule → back to 8");
    const delR = await apiFetch(
      `/api/segments/${seg.id}/rules/${rule3.id}`,
      { method: "DELETE" },
    );
    check("delete returns 200", delR.status === 200);
    const prev9R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const prev9 = (await prev9R.json()) as { count: number | null };
    check(
      "two rules remain, AND-ed → 8",
      prev9.count === 8,
      `got ${prev9.count}`,
    );

    console.log("\n[10] Invalid operator rejected (400)");
    const badOpR = await apiFetch(`/api/segments/${seg.id}/rules`, {
      method: "POST",
      body: JSON.stringify({
        rule_type: "contact_added_in_last_n_days",
        operator: "is_not",
        value: 7,
        is_active: true,
      }),
    });
    check(
      "invalid operator returns 400",
      badOpR.status === 400,
      `got ${badOpR.status}`,
    );

    console.log("\n[11] Invalid value rejected (400)");
    const badValR = await apiFetch(`/api/segments/${seg.id}/rules`, {
      method: "POST",
      body: JSON.stringify({
        rule_type: "is_clicker_for_brand",
        operator: "is",
        value: "not a number",
        is_active: true,
      }),
    });
    check(
      "invalid value returns 400",
      badValR.status === 400,
      `got ${badValR.status}`,
    );

    console.log("\n[12] Non-existent FK rejected (400 ownership check)");
    const ghostR = await apiFetch(`/api/segments/${seg.id}/rules`, {
      method: "POST",
      body: JSON.stringify({
        rule_type: "is_in_contact_group",
        operator: "is",
        value: 999_999_999,
        is_active: true,
      }),
    });
    check(
      "non-existent contact_group_id returns 400",
      ghostR.status === 400,
      `got ${ghostR.status}`,
    );

    console.log("\n[13] refresh-stats computes rule_filtered_count = 8");
    const refR = await apiFetch(`/api/segments/${seg.id}/refresh-stats`, {
      method: "POST",
    });
    check("refresh-stats returns 200", refR.status === 200);
    const ref = (await refR.json()) as {
      total_count: number;
      rule_filtered_count: number | null;
    };
    check(
      "rule_filtered_count = 8",
      ref.rule_filtered_count === 8,
      `got ${ref.rule_filtered_count}`,
    );
    check(
      "total_count unchanged at 5 (manual count)",
      ref.total_count === 5,
      `got ${ref.total_count}`,
    );

    console.log("\n[14] segments/list includes active_rules_count = 2");
    const listSegR = await apiFetch("/api/segments/list?pageSize=500");
    const listSeg = (await listSegR.json()) as {
      data: { id: number; active_rules_count?: number }[];
    };
    const row = listSeg.data.find((s) => s.id === seg.id);
    check(
      "active_rules_count = 2",
      row?.active_rules_count === 2,
      `got ${row?.active_rules_count}`,
    );

    console.log("\n[15] Campaign audience-preview reflects UNION = 8");
    const campPrevR = await apiFetch("/api/campaigns/audience-preview", {
      method: "POST",
      body: JSON.stringify({
        audience_segment_ids: [seg.id],
        audience_filters: {
          include_no_status: true,
          include_opt_in: true,
          include_clickers: true,
          include_not_clicked: true,
        },
      }),
    });
    check("audience-preview returns 200", campPrevR.status === 200);
    const campPrev = (await campPrevR.json()) as { count: number };
    check(
      "campaign UNION audience = 8",
      campPrev.count === 8,
      `got ${campPrev.count}`,
    );

    console.log("\n[16] Delete all rules → back to manual = 5");
    const listForDelR = await apiFetch(`/api/segments/${seg.id}/rules`);
    const listForDel = (await listForDelR.json()) as {
      data: { id: number }[];
    };
    for (const r of listForDel.data) {
      await apiFetch(`/api/segments/${seg.id}/rules/${r.id}`, {
        method: "DELETE",
      });
    }
    const finalPrevR = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const finalPrev = (await finalPrevR.json()) as { count: number };
    check(
      "no-rules preview = 5",
      finalPrev.count === 5,
      `got ${finalPrev.count}`,
    );

    console.log("\n[17] 404 on rules for non-existent segment");
    const ghost404R = await apiFetch("/api/segments/999999999/rules");
    check(
      "non-existent segment → 404",
      ghost404R.status === 404,
      `got ${ghost404R.status}`,
    );

    // ====================================================================
    // Explicit UNION-semantics tests requested in step-6.5-part-2 spec.
    // ====================================================================

    console.log("\n[U1] Manual(5) ∪ rule(7 disjoint) = 12");
    // The current segment seg has 5 manual contacts. Create a fresh contact
    // group containing 7 contacts that are NOT in the segment.
    const u1GroupR = await apiFetch("/api/contact-groups", {
      method: "POST",
      body: JSON.stringify({
        name: `U1 Disjoint Group ${unique}`,
        contact_group_id: `U1-G-${unique}`,
      }),
    });
    const u1Group = (await u1GroupR.json()) as { id: number };
    createdGroupIds.push(u1Group.id);
    // Tag 7 contacts NOT in seg's manual: external[0..6] are all outside
    // seg's manual membership. Tag them all in u1Group.
    await db.insert(contact_contact_groups).values(
      externalPhones.map((p) => ({
        org_id: orgId,
        contact_id: idByPhone.get(p)!,
        contact_group_id: u1Group.id,
      })),
    );

    const u1RuleR = await apiFetch(`/api/segments/${seg.id}/rules`, {
      method: "POST",
      body: JSON.stringify({
        rule_type: "is_in_contact_group",
        operator: "is",
        value: u1Group.id,
        is_active: true,
      }),
    });
    check("U1 rule create 201", u1RuleR.status === 201);
    const u1Rule = (await u1RuleR.json()) as { id: number };
    const u1PrevR = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const u1Prev = (await u1PrevR.json()) as { count: number };
    check(
      "[U1] manual(5) ∪ rule(7 disjoint) = 12",
      u1Prev.count === 12,
      `got ${u1Prev.count}`,
    );

    // Clean up the U1 rule before U2.
    await apiFetch(`/api/segments/${seg.id}/rules/${u1Rule.id}`, {
      method: "DELETE",
    });

    console.log("\n[U2] Manual(4, 3 overlap) ∪ rule(7, 3 overlap + 4 disjoint) = 8");
    // Add one extra contact to seg's manual that is NOT a u1Group member.
    // Manual now has 6 contacts: original 5 + one fresh external.
    // For this exact test we want manual = 4 with 3 overlap. Use a fresh
    // segment to avoid mutating the seed.
    const segU2R = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `U2 Seg ${unique}`,
        segment_id: `U2-SEG-${unique}`,
      }),
    });
    const segU2 = (await segU2R.json()) as { id: number };
    createdSegmentIds.push(segU2.id);
    // U2 manual = 4 contacts: 3 of them are in u1Group (external[0..2]),
    // and 1 that is NOT in u1Group. The fresh manual contact needs a phone
    // outside the existing fixture set.
    const u2ExtraPhone = `+1213900${String(base).padStart(4, "0")}`;
    insertedPhones.push(u2ExtraPhone);
    const u2ManualPhones = [
      externalPhones[0],
      externalPhones[1],
      externalPhones[2],
      u2ExtraPhone,
    ];
    const u2UpR = await apiFetch(
      `/api/segments/${segU2.id}/contacts/upload`,
      {
        method: "POST",
        body: JSON.stringify({ phones: u2ManualPhones.join("\n") }),
      },
    );
    check("U2 manual upload 201", u2UpR.status === 201);

    const u2RuleR = await apiFetch(`/api/segments/${segU2.id}/rules`, {
      method: "POST",
      body: JSON.stringify({
        rule_type: "is_in_contact_group",
        operator: "is",
        value: u1Group.id,
        is_active: true,
      }),
    });
    check("U2 rule create 201", u2RuleR.status === 201);
    const u2PrevR = await apiFetch(
      `/api/segments/${segU2.id}/rules/preview`,
      { method: "POST" },
    );
    const u2Prev = (await u2PrevR.json()) as { count: number };
    check(
      "[U2] manual(4, 3 overlap) ∪ rule(7, 3 overlap + 4 disjoint) = 8",
      u2Prev.count === 8,
      `got ${u2Prev.count}`,
    );

    console.log("\n[U3] Empty rules + 5 manual → exactly 5 (re-confirm short-circuit)");
    const segU3R = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `U3 Seg ${unique}`,
        segment_id: `U3-SEG-${unique}`,
      }),
    });
    const segU3 = (await segU3R.json()) as { id: number };
    createdSegmentIds.push(segU3.id);
    await apiFetch(`/api/segments/${segU3.id}/contacts/upload`, {
      method: "POST",
      body: JSON.stringify({ phones: manualPhones.join("\n") }),
    });
    const u3PrevR = await apiFetch(
      `/api/segments/${segU3.id}/rules/preview`,
      { method: "POST" },
    );
    const u3Prev = (await u3PrevR.json()) as { count: number };
    check(
      "[U3] zero rules + 5 manual = 5",
      u3Prev.count === 5,
      `got ${u3Prev.count}`,
    );

    // ====================================================================
    // Per-rule-type coverage. The setup above seeded:
    //   manual = manualPhones (5 contacts in `seg`)
    //   externalPhones — 7 contacts in the org, not in seg
    //   7 probeBrand clickers: manual[0..1] + external[0..4]
    //   5 group memberships in contactGroup: manual[0] + external[2..5]
    // Each new test creates its own fresh rule on `seg`, asserts the
    // UNION count, then deletes the rule before the next test. The
    // shared inversion invariant is `|is| + |is_not| = |U| + |M|` where
    // U = all org contacts and M = manual membership size.
    // TODO: add coverage for is_optin_any_brand, is_optin_for_brand,
    // contact_added_in_last_n_days (positive case), joined_segment_*
    // in a follow-up pass.
    // ====================================================================

    async function previewCount(segmentId: number): Promise<number> {
      const r = await apiFetch(`/api/segments/${segmentId}/rules/preview`, {
        method: "POST",
      });
      const body = (await r.json()) as { count: number };
      return body.count;
    }

    async function createRule(
      segmentId: number,
      ruleType: string,
      value: unknown,
    ): Promise<number> {
      const r = await apiFetch(`/api/segments/${segmentId}/rules`, {
        method: "POST",
        body: JSON.stringify({
          rule_type: ruleType,
          operator: "is",
          value,
          is_active: true,
        }),
      });
      const body = (await r.json()) as { id: number };
      return body.id;
    }

    async function deleteRule(segmentId: number, ruleId: number) {
      await apiFetch(`/api/segments/${segmentId}/rules/${ruleId}`, {
        method: "DELETE",
      });
    }

    async function patchOperator(
      segmentId: number,
      ruleId: number,
      operator: "is" | "is_not",
    ) {
      await apiFetch(`/api/segments/${segmentId}/rules/${ruleId}`, {
        method: "PATCH",
        body: JSON.stringify({ operator }),
      });
    }

    const totalOrgRow = (await db.execute(drizzleSql`
      SELECT count(*)::int AS n FROM contacts WHERE org_id = ${orgId}::uuid
    `)) as unknown as { n: number }[];
    const totalOrgContacts = totalOrgRow[0]?.n ?? 0;
    const manualSize = 5;
    const inversionExpectedSum = totalOrgContacts + manualSize;
    console.log(
      `  invariant: total_org=${totalOrgContacts} manual=${manualSize} → |is|+|is_not|=${inversionExpectedSum}`,
    );

    console.log("\n[R1] is_clicker_any_brand: 7 clickers, 5 disjoint from manual");
    const r1 = await createRule(seg.id, "is_clicker_any_brand", null);
    const r1Is = await previewCount(seg.id);
    check(
      "[R1] is: manual(5) ∪ 7 clickers (2 in manual) = 10",
      r1Is === 10,
      `got ${r1Is}`,
    );
    await patchOperator(seg.id, r1, "is_not");
    const r1IsNot = await previewCount(seg.id);
    check(
      "[R1] is_not: inversion invariant holds",
      r1Is + r1IsNot === inversionExpectedSum,
      `got ${r1Is}+${r1IsNot}=${r1Is + r1IsNot}, expected ${inversionExpectedSum}`,
    );
    await deleteRule(seg.id, r1);

    console.log("\n[R2] is_clicker_for_offer: 3 clickers tied to offer A");
    // Need an offer scoped to probeBrand.
    const offerAR = await apiFetch("/api/offers", {
      method: "POST",
      body: JSON.stringify({
        name: `Rules Offer ${unique}`,
        offer_id: `RULES-OF-${unique}`,
        brand_id: probeBrandId,
        network_id: testNetworkId,
        payout_model: "cpa",
        payout_cpa: 1,
      }),
    });
    if (offerAR.status !== 201) {
      console.error("offer create failed", await offerAR.text());
      throw new Error("offer create failed");
    }
    const offerA = (await offerAR.json()) as { id: number };
    createdOfferIds.push(offerA.id);
    // Insert 3 offer-A clickers: external[5], external[6], manual[2].
    const offerAClickerPhones = [
      externalPhones[5],
      externalPhones[6],
      manualPhones[2],
    ];
    const offerAContactRows = await db
      .select({ id: contacts.id, phone_number: contacts.phone_number })
      .from(contacts)
      .where(inArray(contacts.phone_number, offerAClickerPhones));
    const offerAClickerInserts = await db
      .insert(clickers)
      .values(
        offerAContactRows.map((c) => ({
          org_id: orgId,
          contact_id: c.id,
          phone_number: c.phone_number,
          brand_id: probeBrandId,
          offer_id: offerA.id,
          source: "test",
        })),
      )
      .returning({ id: clickers.id });
    void offerAClickerInserts;
    const r2 = await createRule(seg.id, "is_clicker_for_offer", offerA.id);
    const r2Is = await previewCount(seg.id);
    // Expected: manual(5) ∪ {external[5], external[6], manual[2]} = 5 + 2 = 7
    check(
      "[R2] is: manual(5) ∪ 3 offer-A clickers (1 in manual) = 7",
      r2Is === 7,
      `got ${r2Is}`,
    );
    await patchOperator(seg.id, r2, "is_not");
    const r2IsNot = await previewCount(seg.id);
    check(
      "[R2] is_not: inversion invariant holds",
      r2Is + r2IsNot === inversionExpectedSum,
      `got ${r2Is}+${r2IsNot}=${r2Is + r2IsNot}, expected ${inversionExpectedSum}`,
    );
    await deleteRule(seg.id, r2);

    console.log("\n[R3] is_optout_for_brand: 3 opt-outs scoped to probeBrand");
    // Insert 3 opt-outs on external[0], external[1], manual[3] + join to brand.
    const optOutPhones = [
      externalPhones[0],
      externalPhones[1],
      manualPhones[3],
    ];
    const optOutContactRows = await db
      .select({ id: contacts.id, phone_number: contacts.phone_number })
      .from(contacts)
      .where(inArray(contacts.phone_number, optOutPhones));
    const optOutInserts = await db
      .insert(opt_outs)
      .values(
        optOutContactRows.map((c) => ({
          org_id: orgId,
          contact_id: c.id,
          phone_number: c.phone_number,
          source: "test",
        })),
      )
      .returning({ id: opt_outs.id });
    await db.insert(opt_out_brands).values(
      optOutInserts.map((o) => ({
        opt_out_id: o.id,
        brand_id: probeBrandId,
      })),
    );
    const r3 = await createRule(seg.id, "is_optout_for_brand", probeBrandId);
    const r3Is = await previewCount(seg.id);
    // Expected: manual(5) ∪ {external[0], external[1], manual[3]} = 5 + 2 = 7
    check(
      "[R3] is: manual(5) ∪ 3 probeBrand opt-outs (1 in manual) = 7",
      r3Is === 7,
      `got ${r3Is}`,
    );
    await patchOperator(seg.id, r3, "is_not");
    const r3IsNot = await previewCount(seg.id);
    check(
      "[R3] is_not: inversion invariant holds",
      r3Is + r3IsNot === inversionExpectedSum,
      `got ${r3Is}+${r3IsNot}=${r3Is + r3IsNot}, expected ${inversionExpectedSum}`,
    );
    await deleteRule(seg.id, r3);

    console.log("\n[R4] member_of_segment: rule references a second segment");
    const segBR = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `Rules SegB ${unique}`,
        segment_id: `RULES-SEGB-${unique}`,
      }),
    });
    const segB = (await segBR.json()) as { id: number };
    createdSegmentIds.push(segB.id);
    // SegB members: external[5], external[6], manual[3], plus a fresh phone.
    const r4FreshPhone = `+1213900${String(base + 100).padStart(4, "0")}`;
    insertedPhones.push(r4FreshPhone);
    const segBPhones = [
      externalPhones[5],
      externalPhones[6],
      manualPhones[3],
      r4FreshPhone,
    ];
    await apiFetch(`/api/segments/${segB.id}/contacts/upload`, {
      method: "POST",
      body: JSON.stringify({ phones: segBPhones.join("\n") }),
    });
    const r4 = await createRule(seg.id, "member_of_segment", segB.id);
    const r4Is = await previewCount(seg.id);
    // Expected: manual(5) ∪ segB(4, 1 in manual) = 5 + 2 external + 1 fresh = 8
    check(
      "[R4] is: manual(5) ∪ segB(4, 1 in manual) = 8",
      r4Is === 8,
      `got ${r4Is}`,
    );
    await patchOperator(seg.id, r4, "is_not");
    const r4IsNot = await previewCount(seg.id);
    // After segB upload + r4 fresh phone, totalOrgContacts has grown.
    const r4TotalRow = (await db.execute(drizzleSql`
      SELECT count(*)::int AS n FROM contacts WHERE org_id = ${orgId}::uuid
    `)) as unknown as { n: number }[];
    const r4ExpectedSum = (r4TotalRow[0]?.n ?? 0) + manualSize;
    check(
      "[R4] is_not: inversion invariant holds (with refreshed totals)",
      r4Is + r4IsNot === r4ExpectedSum,
      `got ${r4Is}+${r4IsNot}=${r4Is + r4IsNot}, expected ${r4ExpectedSum}`,
    );
    await deleteRule(seg.id, r4);

    console.log("\n[R5] contact_added_more_than_n_days_ago: backdated contacts");
    // Insert 3 contacts with explicit old created_at (60 days ago).
    const r5Phones = [
      `+1213910${String(base + 200).padStart(4, "0")}`,
      `+1213910${String(base + 201).padStart(4, "0")}`,
      `+1213910${String(base + 202).padStart(4, "0")}`,
    ];
    insertedPhones.push(...r5Phones);
    await db.execute(drizzleSql`
      INSERT INTO contacts (org_id, phone_number, created_at, updated_at)
      VALUES
        (${orgId}::uuid, ${r5Phones[0]}, now() - interval '60 days', now() - interval '60 days'),
        (${orgId}::uuid, ${r5Phones[1]}, now() - interval '60 days', now() - interval '60 days'),
        (${orgId}::uuid, ${r5Phones[2]}, now() - interval '60 days', now() - interval '60 days')
    `);
    // Baseline: how many existing contacts in this org are >30 days old.
    // Manual fixtures are fresh (this run), so they're not in this set.
    const baselineOldRow = (await db.execute(drizzleSql`
      SELECT count(*)::int AS n FROM contacts
      WHERE org_id = ${orgId}::uuid AND created_at < now() - interval '30 days'
    `)) as unknown as { n: number }[];
    const baselineOld = baselineOldRow[0]?.n ?? 0;
    const r5 = await createRule(
      seg.id,
      "contact_added_more_than_n_days_ago",
      30,
    );
    const r5Is = await previewCount(seg.id);
    // Expected: manual(5) ∪ {contacts > 30 days old} = 5 + baselineOld
    // (manual contacts are this-run, not in the old set; my 3 backdated
    // contacts ARE in the baselineOld count already).
    check(
      "[R5] is: manual(5) ∪ {>30d old} = 5 + baselineOld",
      r5Is === manualSize + baselineOld,
      `got ${r5Is}, expected ${manualSize + baselineOld}`,
    );
    // Inversion not applicable for time-based rules: the validator only
    // allows operator=is for `contact_added_more_than_n_days_ago` (the
    // direction is encoded in the rule_type name). Verify PATCH rejects
    // it instead, as a sanity check on the validator.
    const r5IsNotR = await apiFetch(`/api/segments/${seg.id}/rules/${r5}`, {
      method: "PATCH",
      body: JSON.stringify({ operator: "is_not" }),
    });
    check(
      "[R5] PATCH operator=is_not rejected (time-based rules are is-only)",
      r5IsNotR.status === 400,
      `got ${r5IsNotR.status}`,
    );
    await deleteRule(seg.id, r5);

    // ====================================================================
    // Cross-org PATCH ownership tests. The PATCH endpoint used to skip
    // contact_group_id ownership verification (B2 from the diagnostic);
    // verify it now rejects bad FKs across all shapes.
    // ====================================================================

    console.log("\n[T1] PATCH rule value to ghost contact_group_id → 400");
    const t1Rule = await createRule(seg.id, "is_clicker_any_brand", null);
    const t1R = await apiFetch(`/api/segments/${seg.id}/rules/${t1Rule}`, {
      method: "PATCH",
      body: JSON.stringify({
        rule_type: "is_in_contact_group",
        value: 999_999_999,
      }),
    });
    check(
      "[T1] ghost contact_group_id rejected via PATCH",
      t1R.status === 400,
      `got ${t1R.status}`,
    );
    await deleteRule(seg.id, t1Rule);

    console.log("\n[T2] PATCH rule value to ghost brand_id → 400");
    const t2Rule = await createRule(seg.id, "is_clicker_any_brand", null);
    const t2R = await apiFetch(`/api/segments/${seg.id}/rules/${t2Rule}`, {
      method: "PATCH",
      body: JSON.stringify({
        rule_type: "is_clicker_for_brand",
        value: 999_999_999,
      }),
    });
    check(
      "[T2] ghost brand_id rejected via PATCH",
      t2R.status === 400,
      `got ${t2R.status}`,
    );
    await deleteRule(seg.id, t2Rule);

    console.log(
      "\n[T4] PATCH rule_type to FK shape with value=null persists; eval skips incomplete rule",
    );
    // Tab-switch persistence bug: a rule_type change to an FK shape used
    // to be rejected because the old value was null/incompatible. Now we
    // allow null FK values (rule is "incomplete") and the eval skips it.
    const t4Rule = await createRule(seg.id, "is_clicker_any_brand", null);
    const t4PatchTypeR = await apiFetch(
      `/api/segments/${seg.id}/rules/${t4Rule}`,
      {
        method: "PATCH",
        body: JSON.stringify({ rule_type: "is_in_contact_group" }),
      },
    );
    check(
      "[T4] rule_type swap to FK shape with no value: 200",
      t4PatchTypeR.status === 200,
      `got ${t4PatchTypeR.status}`,
    );
    // Preview should still equal manual (incomplete rule contributes nothing).
    const t4PrevA = await previewCount(seg.id);
    check(
      "[T4] incomplete rule does NOT change audience (count = manual = 5)",
      t4PrevA === 5,
      `got ${t4PrevA}`,
    );
    // Now PATCH the value; the rule should fire.
    const t4PatchValueR = await apiFetch(
      `/api/segments/${seg.id}/rules/${t4Rule}`,
      {
        method: "PATCH",
        body: JSON.stringify({ value: contactGroupId }),
      },
    );
    check(
      "[T4] PATCH value on incomplete rule: 200",
      t4PatchValueR.status === 200,
      `got ${t4PatchValueR.status}`,
    );
    const t4PrevB = await previewCount(seg.id);
    // contactGroup has 5 members (manual[0] + external[2..5]); UNION with
    // manual(5) yields 5 manual + external[2..5] = 9. (manual[0] is in
    // both.)
    check(
      "[T4] completed rule contributes: count = manual(5) ∪ group(5) = 9",
      t4PrevB === 9,
      `got ${t4PrevB}`,
    );
    await deleteRule(seg.id, t4Rule);

    console.log("\n[T3] PATCH member_of_segment value = own segment id → 400");
    const t3Rule = await createRule(seg.id, "is_clicker_any_brand", null);
    const t3R = await apiFetch(`/api/segments/${seg.id}/rules/${t3Rule}`, {
      method: "PATCH",
      body: JSON.stringify({
        rule_type: "member_of_segment",
        value: seg.id,
      }),
    });
    check(
      "[T3] self-referencing member_of_segment rejected",
      t3R.status === 400,
      `got ${t3R.status}`,
    );
    await deleteRule(seg.id, t3Rule);
  } finally {
    console.log("\nCleanup");
    try {
      for (const sid of createdSegmentIds) {
        await db.delete(segments).where(eq(segments.id, sid));
      }
      if (insertedPhones.length > 0) {
        // opt_outs and clickers both cascade on contact delete, but
        // delete them explicitly so opt_out_brands rows go too (cascade
        // on opt_out delete) without relying on contact-cascade order.
        await db
          .delete(opt_outs)
          .where(inArray(opt_outs.phone_number, insertedPhones));
        await db
          .delete(clickers)
          .where(inArray(clickers.phone_number, insertedPhones));
        // contact_contact_groups cascades on contact delete.
        await db
          .delete(contacts)
          .where(inArray(contacts.phone_number, insertedPhones));
      }
      for (const gid of createdGroupIds) {
        await db.delete(contact_groups).where(eq(contact_groups.id, gid));
      }
      // Offers must be deleted before networks (FK ON DELETE SET NULL is
      // safe in either order, but explicit ordering keeps intent obvious).
      // Offers must also be deleted before their brand (ON DELETE CASCADE
      // would otherwise blow them away when the brand is removed).
      for (const oid of createdOfferIds) {
        await db.execute(drizzleSql`DELETE FROM offers WHERE id = ${oid}`);
      }
      for (const nid of createdNetworkIds) {
        await db.execute(
          drizzleSql`DELETE FROM affiliate_networks WHERE id = ${nid}`,
        );
      }
      for (const bid of createdBrandIds) {
        await db.execute(drizzleSql`DELETE FROM brands WHERE id = ${bid}`);
      }
      console.log("  cleanup complete");
    } finally {
      await pg.end({ timeout: 5 });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
