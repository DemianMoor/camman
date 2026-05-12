import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { contacts, segment_groups, segments } from "../db/schema";

type Contact = {
  id: string;
  org_id: string;
  phone_number: string;
  is_archived: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type UploadSummary = {
  submitted: number;
  valid: number;
  invalid: number;
  duplicates_in_input: number;
  duplicates_in_db: number;
  inserted: number;
  invalid_samples: { input: string; error: string }[];
  segments_assigned: number;
};

type ListResponse = { data: Contact[]; totalCount: number };
type BaseStats = {
  total: number;
  archived: number;
  opt_out_count: number;
  opt_in_count: number;
  clicker_count: number;
};

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
      getAll() {
        return Array.from(cookieJar.entries()).map(([name, value]) => ({
          name,
          value,
        }));
      },
      setAll(cookies) {
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
  const insertedNormalizedPhones: string[] = [];
  const createdSegmentIds: number[] = [];
  const createdGroupIds: number[] = [];

  // Use last 4 digits of unique to keep test phones distinct per run.
  const unique = Date.now();
  const u4 = String(unique).slice(-4);
  // Phone-number area code "555" with leading "0" is reserved for fiction —
  // using 555-01xx is unsafe in libphonenumber strictness; use real-looking
  // numbers in the 202 area code (DC) which validate cleanly.
  const usE164 = `+1202555${u4.padStart(4, "0").slice(-4)}`;
  const usRaw = `2025550${u4.padStart(3, "0").slice(-3)}`; // 10-digit raw
  const ukNum = `+44791112${u4.padStart(4, "0").slice(-4)}`;

  try {
    console.log("\n[1] GET /api/contacts/list (initial)");
    const r1 = await apiFetch("/api/contacts/list");
    check("returns 200", r1.status === 200);
    const body1 = (await r1.json()) as ListResponse;
    const initialTotal = body1.totalCount;

    console.log("\n[2] POST /api/contacts/upload (mixed payload)");
    const mixed = [
      usE164,
      usRaw,
      ukNum,
      usE164, // duplicate within input
      usE164, // another duplicate within input
      "not-a-phone",
      "   ", // whitespace-only → filtered before validation, doesn't count as submitted
    ].join("\n");

    // We expect: submitted=6 (whitespace filtered before validation),
    // valid=5 (3 distinct US + 2 duplicates of first US), invalid=1,
    // duplicates_in_input=2, inserted=3, duplicates_in_db=0.
    const r2 = await apiFetch("/api/contacts/upload", {
      method: "POST",
      body: JSON.stringify({ phones: mixed }),
    });
    check("returns 201", r2.status === 201, `got ${r2.status}`);
    const summary = (await r2.json()) as UploadSummary;
    console.log(`    summary = ${JSON.stringify(summary, null, 2)}`);
    check("submitted = 6 (whitespace filtered)", summary.submitted === 6);
    check("valid = 5", summary.valid === 5);
    check("invalid = 1", summary.invalid === 1);
    check("duplicates_in_input = 2", summary.duplicates_in_input === 2);
    check("duplicates_in_db = 0", summary.duplicates_in_db === 0);
    check("inserted = 3", summary.inserted === 3);
    check(
      "invalid_samples capped",
      Array.isArray(summary.invalid_samples) &&
        summary.invalid_samples.length <= 20,
    );
    // Track normalized phones we know are in the DB for cleanup.
    insertedNormalizedPhones.push(usE164, ukNum);
    // The raw US gets normalized to +1 + 10 digits.
    insertedNormalizedPhones.push(`+1${usRaw}`);

    console.log("\n[3] Re-upload same payload (all duplicates in DB)");
    const r3 = await apiFetch("/api/contacts/upload", {
      method: "POST",
      body: JSON.stringify({ phones: mixed }),
    });
    const s3 = (await r3.json()) as UploadSummary;
    check("returns 201", r3.status === 201);
    check("inserted = 0 (all dups)", s3.inserted === 0);
    check("duplicates_in_db = 3", s3.duplicates_in_db === 3);

    console.log("\n[4] GET /api/contacts/list (3 new rows visible)");
    const r4 = await apiFetch("/api/contacts/list");
    const body4 = (await r4.json()) as ListResponse;
    check(
      "totalCount increased by 3",
      body4.totalCount === initialTotal + 3,
      `expected ${initialTotal + 3}, got ${body4.totalCount}`,
    );

    console.log("\n[5] GET /api/contacts/base-stats");
    const r5 = await apiFetch("/api/contacts/base-stats");
    check("returns 200", r5.status === 200);
    const stats = (await r5.json()) as BaseStats;
    check(
      "total counts non-archived only",
      stats.total >= 3 && stats.total === body4.totalCount,
    );
    check("opt_out_count placeholder = 0", stats.opt_out_count === 0);
    check("opt_in_count placeholder = 0", stats.opt_in_count === 0);
    check("clicker_count placeholder = 0", stats.clicker_count === 0);

    console.log("\n[6] Archive one contact via dedicated endpoint");
    const oneToArchive = body4.data.find((c) =>
      insertedNormalizedPhones.includes(c.phone_number),
    );
    if (!oneToArchive) {
      throw new Error("Couldn't find a freshly-inserted contact to archive");
    }
    const r6 = await apiFetch(`/api/contacts/${oneToArchive.id}/archive`, {
      method: "POST",
    });
    check("archive returns 200", r6.status === 200);
    const archived = (await r6.json()) as Contact;
    check("is_archived true", archived.is_archived === true);
    check("archived_at set", archived.archived_at !== null);

    console.log("\n[7] List (default — archived hidden)");
    const r7 = await apiFetch("/api/contacts/list");
    const body7 = (await r7.json()) as ListResponse;
    check(
      "archived contact not in default list",
      !body7.data.some((c) => c.id === oneToArchive.id),
    );

    console.log("\n[8] List (showArchived=true — sees archived)");
    const r8 = await apiFetch("/api/contacts/list?showArchived=true");
    const body8 = (await r8.json()) as ListResponse;
    check(
      "archived contact appears with showArchived=true",
      body8.data.some((c) => c.id === oneToArchive.id),
    );

    console.log("\n[9] Restore the archived contact");
    const r9 = await apiFetch(`/api/contacts/${oneToArchive.id}/restore`, {
      method: "POST",
    });
    check("restore returns 200", r9.status === 200);
    const restored = (await r9.json()) as Contact;
    check("is_archived false", restored.is_archived === false);
    check("archived_at null", restored.archived_at === null);

    console.log("\n[10] DELETE one contact (manager+ permission)");
    const oneToDelete = body4.data.find(
      (c) =>
        insertedNormalizedPhones.includes(c.phone_number) &&
        c.id !== oneToArchive.id,
    );
    if (!oneToDelete) {
      throw new Error("Couldn't find a freshly-inserted contact to delete");
    }
    const rDel = await apiFetch(`/api/contacts/${oneToDelete.id}`, {
      method: "DELETE",
    });
    check("delete returns 200", rDel.status === 200, `got ${rDel.status}`);
    const delBody = await rDel.json();
    check(
      "response body has ok=true and matching id",
      delBody.ok === true && delBody.id === oneToDelete.id,
    );
    const rGetGone = await apiFetch(`/api/contacts/${oneToDelete.id}`);
    check(
      "subsequent GET returns 404",
      rGetGone.status === 404,
      `got ${rGetGone.status}`,
    );

    console.log("\n[11] Performance smoke: upload 1000 distinct phones");
    // Generate 1000 phones in +12025XX_XXXX_XXXX form — varying middle to ensure
    // unique normalizations.
    const big: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const suffix = String(i).padStart(4, "0");
      // Area code 213 (LA) is valid; vary the exchange (5xx)
      // to avoid collisions with the test triple above.
      big.push(`+1213600${suffix}`);
    }
    const t0 = performance.now();
    const r10 = await apiFetch("/api/contacts/upload", {
      method: "POST",
      body: JSON.stringify({ phones: big.join("\n") }),
    });
    const elapsedMs = performance.now() - t0;
    check("returns 201", r10.status === 201, `got ${r10.status}`);
    const s10 = (await r10.json()) as UploadSummary;
    console.log(
      `    perf: 1000 phones in ${elapsedMs.toFixed(0)}ms (inserted=${s10.inserted}, valid=${s10.valid}, invalid=${s10.invalid})`,
    );
    check("submitted = 1000", s10.submitted === 1000);
    check(
      "completed under 5s target",
      elapsedMs < 5000,
      `${elapsedMs.toFixed(0)}ms`,
    );
    check("at least 990 inserted (allowing for libphonenumber strictness)", s10.inserted >= 990);
    // Remember these for cleanup
    for (const p of big) insertedNormalizedPhones.push(p);

    // ============ Amendment 2 — upload-with-assignment ============
    console.log("\n[12] Set up a group with 2 segments for assignment tests");
    const grpR = await apiFetch("/api/segment-groups", {
      method: "POST",
      body: JSON.stringify({
        name: `Assign Group ${unique}`,
        segment_group_id: `ASSIGN-G-${unique}`,
      }),
    });
    check("group creation returns 201", grpR.status === 201);
    const grp = (await grpR.json()) as { id: number };
    createdGroupIds.push(grp.id);

    const segAR = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `Assign Seg A ${unique}`,
        segment_id: `ASSIGN-A-${unique}`,
        segment_group_ids: [grp.id],
      }),
    });
    const segA = (await segAR.json()) as { id: number };
    createdSegmentIds.push(segA.id);

    const segBR = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `Assign Seg B ${unique}`,
        segment_id: `ASSIGN-B-${unique}`,
        segment_group_ids: [grp.id],
      }),
    });
    const segB = (await segBR.json()) as { id: number };
    createdSegmentIds.push(segB.id);

    // A third segment NOT in the group — proves group-scope is respected.
    const segOuterR = await apiFetch("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name: `Assign Seg Outer ${unique}`,
        segment_id: `ASSIGN-O-${unique}`,
      }),
    });
    const segOuter = (await segOuterR.json()) as { id: number };
    createdSegmentIds.push(segOuter.id);

    console.log("\n[13] Upload with single-segment assignment");
    const assignPhones1: string[] = [];
    for (let i = 0; i < 5; i++) {
      assignPhones1.push(`+1213700${String(i).padStart(4, "0")}`);
    }
    insertedNormalizedPhones.push(...assignPhones1);
    const r13 = await apiFetch("/api/contacts/upload", {
      method: "POST",
      body: JSON.stringify({
        phones: assignPhones1.join("\n"),
        assign_to_segment_id: segA.id,
      }),
    });
    check("returns 201", r13.status === 201);
    const s13 = (await r13.json()) as UploadSummary;
    check("segments_assigned = 1", s13.segments_assigned === 1);
    // Verify membership landed.
    const segADetailR = await apiFetch(`/api/segments/${segA.id}`);
    const segADetail = (await segADetailR.json()) as {
      stats: { total_count: number };
    };
    check(
      "segA total_count = 5 (trigger fired via assignment)",
      segADetail.stats.total_count === 5,
      `got ${segADetail.stats.total_count}`,
    );

    console.log("\n[14] Upload with group assignment (lands in both segments)");
    const assignPhones2: string[] = [];
    for (let i = 0; i < 4; i++) {
      assignPhones2.push(`+1213800${String(i).padStart(4, "0")}`);
    }
    insertedNormalizedPhones.push(...assignPhones2);
    const r14 = await apiFetch("/api/contacts/upload", {
      method: "POST",
      body: JSON.stringify({
        phones: assignPhones2.join("\n"),
        assign_to_segment_group_id: grp.id,
      }),
    });
    check("returns 201", r14.status === 201);
    const s14 = (await r14.json()) as UploadSummary;
    check(
      "segments_assigned = 2 (both group members)",
      s14.segments_assigned === 2,
      `got ${s14.segments_assigned}`,
    );
    const segADetail2R = await apiFetch(`/api/segments/${segA.id}`);
    const segADetail2 = (await segADetail2R.json()) as {
      stats: { total_count: number };
    };
    check(
      "segA gained 4 more (5 + 4 = 9)",
      segADetail2.stats.total_count === 9,
      `got ${segADetail2.stats.total_count}`,
    );
    const segBDetailR = await apiFetch(`/api/segments/${segB.id}`);
    const segBDetail = (await segBDetailR.json()) as {
      stats: { total_count: number };
    };
    check(
      "segB has 4",
      segBDetail.stats.total_count === 4,
      `got ${segBDetail.stats.total_count}`,
    );
    const segOuterDetailR = await apiFetch(`/api/segments/${segOuter.id}`);
    const segOuterDetail = (await segOuterDetailR.json()) as {
      stats: { total_count: number };
    };
    check(
      "outer segment unaffected (0)",
      segOuterDetail.stats.total_count === 0,
    );

    console.log("\n[15] Upload with BOTH segment + group → 400");
    const r15 = await apiFetch("/api/contacts/upload", {
      method: "POST",
      body: JSON.stringify({
        phones: `+1213900${u4.padStart(4, "0")}`,
        assign_to_segment_id: segA.id,
        assign_to_segment_group_id: grp.id,
      }),
    });
    check("returns 400", r15.status === 400, `got ${r15.status}`);

    console.log("\n[16] Upload with NO assignment → segments_assigned = 0");
    const noAssignPhone = `+1214000${u4.padStart(4, "0")}`;
    insertedNormalizedPhones.push(noAssignPhone);
    const r16 = await apiFetch("/api/contacts/upload", {
      method: "POST",
      body: JSON.stringify({ phones: noAssignPhone }),
    });
    check("returns 201", r16.status === 201);
    const s16 = (await r16.json()) as UploadSummary;
    check("segments_assigned = 0", s16.segments_assigned === 0);
  } finally {
    console.log("\nCleanup");
    try {
      for (const sid of createdSegmentIds) {
        await db.delete(segments).where(eq(segments.id, sid));
      }
      for (const gid of createdGroupIds) {
        await db.delete(segment_groups).where(eq(segment_groups.id, gid));
      }
      if (insertedNormalizedPhones.length > 0) {
        const deleted = await db
          .delete(contacts)
          .where(inArray(contacts.phone_number, insertedNormalizedPhones))
          .returning({ id: contacts.id });
        console.log(`  deleted ${deleted.length} test contacts`);
      }
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
