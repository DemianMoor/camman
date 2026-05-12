import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  brands,
  contacts,
  opt_ins,
  opt_outs,
  segment_groups,
  segments,
} from "../db/schema";

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

  const createdSegmentIds: number[] = [];
  const createdGroupIds: number[] = [];
  const createdBrandIds: number[] = [];
  const insertedPhones: string[] = [];
  let orgId: string | null = null;
  let probeBrandId = 0;

  try {
    // Probe brand also discovers org_id.
    const probeR = await apiFetch("/api/brands", {
      method: "POST",
      body: JSON.stringify({
        name: "Seg Probe Brand",
        brand_id: `PROBE-SEG-${unique}`,
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

    // Build a few test phones we'll reuse across segments.
    const u4 = String(unique).slice(-4);
    const seg1Phones = [
      `+1213700${u4}1`,
      `+1213700${u4}2`,
      `+1213700${u4}3`,
      `+1213700${u4}4`,
      `+1213700${u4}5`,
    ];
    const seg2Phones = [
      `+1213700${u4}3`,
      `+1213700${u4}4`,
      `+1213700${u4}5`,
      `+1213700${u4}6`,
      `+1213700${u4}7`,
    ];
    const seg3Phones = [
      `+1213700${u4}4`,
      `+1213700${u4}5`,
      `+1213700${u4}6`,
      `+1213700${u4}8`,
    ];
    insertedPhones.push(
      ...Array.from(new Set([...seg1Phones, ...seg2Phones, ...seg3Phones])),
    );

    console.log("\n[1] POST create segment group + 3 segments");
    const groupR = await apiFetch("/api/segment-groups", {
      method: "POST",
      body: JSON.stringify({
        name: `Test Group ${unique}`,
        segment_group_id: `TGRP-${unique}`,
      }),
    });
    check("group creation returns 201", groupR.status === 201);
    const group = (await groupR.json()) as { id: number };
    createdGroupIds.push(group.id);

    const seg1R = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `Seg A ${unique}`,
        segment_id: `SEGA-${unique}`,
        segment_group_ids: [group.id],
      }),
    });
    check("segment A creation returns 201", seg1R.status === 201);
    const seg1 = (await seg1R.json()) as { id: number };
    createdSegmentIds.push(seg1.id);

    const seg2R = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `Seg B ${unique}`,
        segment_id: `SEGB-${unique}`,
      }),
    });
    check("segment B creation returns 201", seg2R.status === 201);
    const seg2 = (await seg2R.json()) as { id: number };
    createdSegmentIds.push(seg2.id);

    const seg3R = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `Seg C ${unique}`,
        segment_id: `SEGC-${unique}`,
      }),
    });
    check("segment C creation returns 201", seg3R.status === 201);
    const seg3 = (await seg3R.json()) as { id: number };
    createdSegmentIds.push(seg3.id);

    console.log("\n[1b] Multi-group membership via PATCH");
    // Create a second group and assign seg2 to BOTH groups via PATCH.
    const group2R = await apiFetch("/api/segment-groups", {
      method: "POST",
      body: JSON.stringify({
        name: `Test Group 2 ${unique}`,
        segment_group_id: `TGRP2-${unique}`,
      }),
    });
    check("group 2 creation returns 201", group2R.status === 201);
    const group2 = (await group2R.json()) as { id: number };
    createdGroupIds.push(group2.id);

    const patchR = await apiFetch(`/api/segments/${seg2.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        segment_group_ids: [group.id, group2.id],
      }),
    });
    check("PATCH multi-group returns 200", patchR.status === 200);

    const detailMultiR = await apiFetch(`/api/segments/${seg2.id}`);
    const detailMulti = (await detailMultiR.json()) as {
      segment_groups: { id: number; name: string }[];
    };
    check(
      "GET returns 2 groups joined",
      detailMulti.segment_groups.length === 2,
      `got ${detailMulti.segment_groups.length}`,
    );
    check(
      "groups include both ids",
      detailMulti.segment_groups.some((g) => g.id === group.id) &&
        detailMulti.segment_groups.some((g) => g.id === group2.id),
    );

    // Replace memberships with just the second group (empty + non-empty path).
    const patchReplaceR = await apiFetch(`/api/segments/${seg2.id}`, {
      method: "PATCH",
      body: JSON.stringify({ segment_group_ids: [group2.id] }),
    });
    check(
      "PATCH replace memberships returns 200",
      patchReplaceR.status === 200,
    );
    const detailAfterReplaceR = await apiFetch(`/api/segments/${seg2.id}`);
    const detailAfterReplace = (await detailAfterReplaceR.json()) as {
      segment_groups: { id: number }[];
    };
    check(
      "memberships replaced (now 1 group)",
      detailAfterReplace.segment_groups.length === 1 &&
        detailAfterReplace.segment_groups[0].id === group2.id,
    );

    // Empty array clears all memberships.
    const patchClearR = await apiFetch(`/api/segments/${seg2.id}`, {
      method: "PATCH",
      body: JSON.stringify({ segment_group_ids: [] }),
    });
    check("PATCH clear memberships returns 200", patchClearR.status === 200);
    const detailClearedR = await apiFetch(`/api/segments/${seg2.id}`);
    const detailCleared = (await detailClearedR.json()) as {
      segment_groups: { id: number }[];
    };
    check(
      "memberships cleared",
      detailCleared.segment_groups.length === 0,
    );

    console.log("\n[2] GET segment detail — segment_stats row exists (zeros)");
    const detailR = await apiFetch(`/api/segments/${seg1.id}`);
    const detail = (await detailR.json()) as {
      stats: { total_count: number };
    };
    check("stats.total_count starts at 0", detail.stats.total_count === 0);

    console.log("\n[3] POST upload phones to seg A");
    const uploadR = await apiFetch(
      `/api/segments/${seg1.id}/contacts/upload`,
      {
        method: "POST",
        body: JSON.stringify({ phones: seg1Phones.join("\n") }),
      },
    );
    check("upload returns 201", uploadR.status === 201);
    const uploadSummary = await uploadR.json();
    check("inserted = 5", uploadSummary.inserted === 5);

    console.log("\n[4] GET seg A detail — total_count = 5 (trigger fired)");
    const detail2R = await apiFetch(`/api/segments/${seg1.id}`);
    const detail2 = (await detail2R.json()) as {
      stats: { total_count: number };
    };
    check(
      "trigger updated total_count to 5",
      detail2.stats.total_count === 5,
      `got ${detail2.stats.total_count}`,
    );

    // Upload phones to seg B and seg C so we can test overlaps later.
    await apiFetch(`/api/segments/${seg2.id}/contacts/upload`, {
      method: "POST",
      body: JSON.stringify({ phones: seg2Phones.join("\n") }),
    });
    await apiFetch(`/api/segments/${seg3.id}/contacts/upload`, {
      method: "POST",
      body: JSON.stringify({ phones: seg3Phones.join("\n") }),
    });

    console.log("\n[5] Add some opt-outs + opt-ins, then refresh-stats");
    // Find the contact_ids for phones in seg1 to seed opt-outs/opt-ins.
    const cRows = await db
      .select({ id: contacts.id, phone_number: contacts.phone_number })
      .from(contacts)
      .where(inArray(contacts.phone_number, seg1Phones));
    // First two phones get opt-out records, next two get opt-in records.
    const optOutPhones = seg1Phones.slice(0, 2);
    const optInPhones = seg1Phones.slice(2, 4);

    const optOutInserts = await db
      .insert(opt_outs)
      .values(
        cRows
          .filter((c) => optOutPhones.includes(c.phone_number))
          .map((c) => ({
            org_id: orgId!,
            contact_id: c.id,
            phone_number: c.phone_number,
            source: "test",
          })),
      )
      .returning({ id: opt_outs.id });
    void optOutInserts;

    const optInInserts = await db
      .insert(opt_ins)
      .values(
        cRows
          .filter((c) => optInPhones.includes(c.phone_number))
          .map((c) => ({
            org_id: orgId!,
            contact_id: c.id,
            phone_number: c.phone_number,
            brand_id: probeBrandId,
            source: "test",
          })),
      )
      .returning({ id: opt_ins.id });
    void optInInserts;

    const refreshR = await apiFetch(
      `/api/segments/${seg1.id}/refresh-stats`,
      { method: "POST" },
    );
    check("refresh-stats returns 200", refreshR.status === 200);
    const refreshed = (await refreshR.json()) as {
      total_count: number;
      opt_out_count: number;
      opt_in_count: number;
      clicker_count: number;
    };
    check(
      "total_count after refresh = 5",
      refreshed.total_count === 5,
      `got ${refreshed.total_count}`,
    );
    check(
      "opt_out_count = 2",
      refreshed.opt_out_count === 2,
      `got ${refreshed.opt_out_count}`,
    );
    check(
      "opt_in_count = 2",
      refreshed.opt_in_count === 2,
      `got ${refreshed.opt_in_count}`,
    );
    check(
      "clicker_count = 0",
      refreshed.clicker_count === 0,
      `got ${refreshed.clicker_count}`,
    );

    console.log("\n[6] POST remove 2 phones from seg A");
    const removeR = await apiFetch(
      `/api/segments/${seg1.id}/contacts/remove`,
      {
        method: "POST",
        body: JSON.stringify({ phones: seg1Phones.slice(0, 2).join("\n") }),
      },
    );
    check("remove returns 200", removeR.status === 200);
    const removeSummary = (await removeR.json()) as {
      removed: number;
      not_found: number;
    };
    check("removed = 2", removeSummary.removed === 2);

    const detail3R = await apiFetch(`/api/segments/${seg1.id}`);
    const detail3 = (await detail3R.json()) as {
      stats: { total_count: number };
    };
    check(
      "total_count decremented to 3 via trigger",
      detail3.stats.total_count === 3,
      `got ${detail3.stats.total_count}`,
    );

    console.log("\n[7] GET segments list — segment_count badges via stats join");
    const listR = await apiFetch("/api/segments/list?pageSize=100");
    const list = (await listR.json()) as {
      data: Array<{
        id: number;
        stats: { total_count: number };
      }>;
    };
    const segARow = list.data.find((s) => s.id === seg1.id);
    check(
      "list endpoint returns joined stats",
      segARow !== undefined && segARow.stats.total_count === 3,
      `got total_count=${segARow?.stats.total_count}`,
    );

    console.log("\n[8] POST overlaps with 3 segments");
    const overlapsR = await apiFetch("/api/segments/overlaps", {
      method: "POST",
      body: JSON.stringify({
        segment_ids: [seg1.id, seg2.id, seg3.id],
      }),
    });
    check("overlaps returns 200", overlapsR.status === 200);
    const overlapsBody = (await overlapsR.json()) as {
      overlaps: { segment_ids: number[]; count: number }[];
    };
    // After removing first 2 phones from seg A, seg A has phones [3, 4, 5].
    // seg B has [3, 4, 5, 6, 7]. seg C has [4, 5, 6, 8].
    // A ∩ B = {3, 4, 5} = 3
    // A ∩ C = {4, 5} = 2
    // B ∩ C = {4, 5, 6} = 3
    // A ∩ B ∩ C = {4, 5} = 2
    const findOverlap = (...ids: number[]) => {
      const sorted = [...ids].sort((a, b) => a - b);
      return overlapsBody.overlaps.find(
        (o) =>
          o.segment_ids.length === sorted.length &&
          o.segment_ids.every((id, i) => id === sorted[i]),
      );
    };
    const ab = findOverlap(seg1.id, seg2.id);
    check(
      "A ∩ B = 3",
      ab !== undefined && ab.count === 3,
      `got ${ab?.count}`,
    );
    const ac = findOverlap(seg1.id, seg3.id);
    check(
      "A ∩ C = 2",
      ac !== undefined && ac.count === 2,
      `got ${ac?.count}`,
    );
    const bc = findOverlap(seg2.id, seg3.id);
    check(
      "B ∩ C = 3",
      bc !== undefined && bc.count === 3,
      `got ${bc?.count}`,
    );
    const abc = findOverlap(seg1.id, seg2.id, seg3.id);
    check(
      "A ∩ B ∩ C = 2",
      abc !== undefined && abc.count === 2,
      `got ${abc?.count}`,
    );

    console.log("\n[9] Cross-page wiring — segment-groups segment_count");
    const groupListR = await apiFetch("/api/segment-groups/list?pageSize=100");
    const groupList = (await groupListR.json()) as {
      data: Array<{ id: number; segment_count: number }>;
    };
    const ourGroup = groupList.data.find((g) => g.id === group.id);
    check(
      "group has segment_count = 1 (seg A is in this group)",
      ourGroup !== undefined && ourGroup.segment_count === 1,
      `got ${ourGroup?.segment_count}`,
    );

    console.log("\n[10] Cross-page wiring — contacts list segment_id filter");
    const contactsR = await apiFetch(
      `/api/contacts/list?segment_id=${seg1.id}&pageSize=100`,
    );
    const contactsBody = (await contactsR.json()) as {
      data: { phone_number: string }[];
    };
    const inSeg1 = contactsBody.data.filter((c) =>
      seg1Phones.slice(2).includes(c.phone_number),
    );
    check(
      "contacts list filtered to segment A returns 3 contacts",
      inSeg1.length === 3,
      `got ${inSeg1.length}`,
    );

    console.log("\n[11] Performance — 5000-contact upload to a new segment");
    const perfSegR = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `Perf Seg ${unique}`,
        segment_id: `SEG-PERF-${unique}`,
      }),
    });
    check("perf segment creation returns 201", perfSegR.status === 201);
    const perfSeg = (await perfSegR.json()) as { id: number };
    createdSegmentIds.push(perfSeg.id);

    const big: string[] = [];
    for (let i = 0; i < 5000; i++) {
      big.push(`+1213800${String(i).padStart(4, "0")}`);
    }
    insertedPhones.push(...big);

    const t0 = performance.now();
    const perfR = await apiFetch(
      `/api/segments/${perfSeg.id}/contacts/upload`,
      {
        method: "POST",
        body: JSON.stringify({ phones: big.join("\n") }),
      },
    );
    const elapsedMs = performance.now() - t0;
    check("perf upload returns 201", perfR.status === 201, `got ${perfR.status}`);
    const perfSummary = (await perfR.json()) as { inserted: number };
    console.log(`    perf: 5000-row segment upload in ${elapsedMs.toFixed(0)}ms`);
    check(
      "5000 inserted",
      perfSummary.inserted === 5000,
      `got ${perfSummary.inserted}`,
    );
    check(
      "under 20s",
      elapsedMs < 20000,
      `${elapsedMs.toFixed(0)}ms`,
    );

    // Verify the trigger kept up with 5000 row-level firings.
    const perfDetailR = await apiFetch(`/api/segments/${perfSeg.id}`);
    const perfDetail = (await perfDetailR.json()) as {
      stats: { total_count: number };
    };
    check(
      "trigger updated total_count to 5000 across all chunks",
      perfDetail.stats.total_count === 5000,
      `got ${perfDetail.stats.total_count}`,
    );

    console.log("\n[12] DELETE segment cascades to junction + stats");
    const delR = await apiFetch(`/api/segments/${seg3.id}`, {
      method: "DELETE",
    });
    check("delete returns 200", delR.status === 200);
    const verifyR = await apiFetch(`/api/segments/${seg3.id}`);
    check("deleted segment is 404", verifyR.status === 404);
    createdSegmentIds.splice(createdSegmentIds.indexOf(seg3.id), 1);

    console.log("\n[13] refresh-all touches every segment");
    const refreshAllR = await apiFetch("/api/segment-stats/refresh-all", {
      method: "POST",
    });
    check("refresh-all returns 200", refreshAllR.status === 200);
    const refreshAll = (await refreshAllR.json()) as {
      refreshed: number;
      total_segments: number;
    };
    check(
      "refreshed count matches total_segments",
      refreshAll.refreshed === refreshAll.total_segments,
      `${refreshAll.refreshed} / ${refreshAll.total_segments}`,
    );
  } finally {
    console.log("\nCleanup");
    try {
      for (const sid of createdSegmentIds) {
        await db.delete(segments).where(eq(segments.id, sid));
      }
      for (const gid of createdGroupIds) {
        await db.delete(segment_groups).where(eq(segment_groups.id, gid));
      }
      if (insertedPhones.length > 0) {
        await db
          .delete(opt_outs)
          .where(inArray(opt_outs.phone_number, insertedPhones));
        await db
          .delete(opt_ins)
          .where(inArray(opt_ins.phone_number, insertedPhones));
        await db
          .delete(contacts)
          .where(inArray(contacts.phone_number, insertedPhones));
      }
      for (const bid of createdBrandIds) {
        await db.delete(brands).where(eq(brands.id, bid));
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
