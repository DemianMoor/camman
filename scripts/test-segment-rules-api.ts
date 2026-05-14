import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { clickers, contacts, segments } from "../db/schema";

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
  const createdBrandIds: number[] = [];
  const insertedPhones: string[] = [];
  let orgId = "";
  let probeBrandId = 0;
  let otherBrandId = 0;

  try {
    // Probe brand discovers org_id; we also need one to attach clickers to.
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

    // Use 213-555-0XXX range (10 digits national → valid US format).
    const u3 = String(unique).slice(-3);
    const segPhones = [
      `+12135550${u3}`.slice(0, 12).padEnd(12, "0"),
    ];
    // Generate 5 unique 10-digit phones based on `unique`.
    segPhones.length = 0;
    const base = Number(String(unique).slice(-7)) % 9000000 + 1000000;
    for (let i = 0; i < 5; i++) {
      const n = base + i;
      segPhones.push(`+1213${String(n).padStart(7, "0")}`);
    }
    insertedPhones.push(...segPhones);

    console.log("\n[setup] Create segment, upload 5 phones");
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
      body: JSON.stringify({ phones: segPhones.join("\n") }),
    });
    check("upload returns 201", upR.status === 201);

    // Seed clicker data for the probe brand on 2 of the 5 phones.
    const cRows = await db
      .select({ id: contacts.id, phone_number: contacts.phone_number })
      .from(contacts)
      .where(inArray(contacts.phone_number, segPhones));
    if (cRows.length < 5) {
      throw new Error(
        `expected 5 contacts after upload, found ${cRows.length}. phones=${JSON.stringify(segPhones)} matched=${JSON.stringify(cRows.map((c) => c.phone_number))}`,
      );
    }
    const clickerPhones = segPhones.slice(0, 2);
    const clickerRows = cRows
      .filter((c) => clickerPhones.includes(c.phone_number))
      .map((c) => ({
        org_id: orgId,
        contact_id: c.id,
        phone_number: c.phone_number,
        brand_id: probeBrandId,
        source: "test" as const,
      }));
    if (clickerRows.length === 0) {
      throw new Error("no clicker rows to insert");
    }
    await db.insert(clickers).values(clickerRows);

    console.log("\n[1] Empty rules → preview matches manual count (5)");
    const empty1R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    if (empty1R.status !== 200) {
      const t = await empty1R.text();
      console.error("preview status:", empty1R.status, "body:", t);
    }
    check("preview returns 200", empty1R.status === 200);
    const empty1 = (await empty1R.json()) as {
      count: number | null;
      manual_count: number;
      rule_filtered_count: number | null;
      truncated: boolean;
    };
    check(
      "empty rules count = manual_count = 5",
      empty1.count === 5 && empty1.manual_count === 5,
      `got count=${empty1.count} manual=${empty1.manual_count}`,
    );
    check(
      "empty rules rule_filtered_count = 5 (zero-rule short-circuit)",
      empty1.rule_filtered_count === 5,
      `got ${empty1.rule_filtered_count}`,
    );

    console.log("\n[2] List rules — should be empty");
    const list0R = await apiFetch(`/api/segments/${seg.id}/rules`);
    const list0 = (await list0R.json()) as { data: unknown[] };
    check("rules list empty", list0.data.length === 0);

    console.log("\n[3] Create rule: is_clicker_any_brand is (engagement)");
    const create1R = await apiFetch(`/api/segments/${seg.id}/rules`, {
      method: "POST",
      body: JSON.stringify({
        rule_type: "is_clicker_any_brand",
        operator: "is",
        value: null,
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
    check("rule.rule_type = is_clicker_any_brand", rule1.rule_type === "is_clicker_any_brand");

    console.log("\n[4] Preview after rule add — narrows to 2 clickers");
    const prev2R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const prev2 = (await prev2R.json()) as { count: number | null; truncated: boolean };
    check("count = 2 (clickers only)", prev2.count === 2, `got ${prev2.count}`);

    console.log("\n[5] Inversion: is_not flips to 3 non-clickers");
    const patch1R = await apiFetch(
      `/api/segments/${seg.id}/rules/${rule1.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ operator: "is_not" }),
      },
    );
    check("PATCH operator returns 200", patch1R.status === 200);
    const prev3R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const prev3 = (await prev3R.json()) as { count: number | null };
    check("count = 3 (non-clickers)", prev3.count === 3, `got ${prev3.count}`);

    console.log("\n[6] is_active=false disables rule (back to 5)");
    const patch2R = await apiFetch(
      `/api/segments/${seg.id}/rules/${rule1.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ is_active: false }),
      },
    );
    check("PATCH is_active returns 200", patch2R.status === 200);
    const prev4R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const prev4 = (await prev4R.json()) as { count: number | null };
    check(
      "count = 5 (rule is inactive)",
      prev4.count === 5,
      `got ${prev4.count}`,
    );
    // Re-enable and switch back to is, so we can compound.
    await apiFetch(`/api/segments/${seg.id}/rules/${rule1.id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_active: true, operator: "is" }),
    });

    console.log("\n[7] Compound AND: add brand-specific clicker rule");
    const create2R = await apiFetch(`/api/segments/${seg.id}/rules`, {
      method: "POST",
      body: JSON.stringify({
        rule_type: "is_clicker_for_brand",
        operator: "is",
        value: probeBrandId,
        is_active: true,
      }),
    });
    check("rule 2 create returns 201", create2R.status === 201);
    const rule2 = (await create2R.json()) as { id: number };
    const prev5R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const prev5 = (await prev5R.json()) as { count: number | null };
    check(
      "compound (any-brand-clicker AND probeBrand-clicker) = 2",
      prev5.count === 2,
      `got ${prev5.count}`,
    );

    // Add a rule referencing otherBrand — clickers exist only for probeBrand,
    // so the AND must collapse to 0.
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
    const prev6R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const prev6 = (await prev6R.json()) as { count: number | null };
    check(
      "AND with otherBrand-clicker = 0",
      prev6.count === 0,
      `got ${prev6.count}`,
    );

    console.log("\n[8] Reorder rules — semantics unchanged after swap");
    const reorderR = await apiFetch(
      `/api/segments/${seg.id}/rules/reorder`,
      {
        method: "POST",
        body: JSON.stringify({ rule_ids: [rule3.id, rule1.id, rule2.id] }),
      },
    );
    check("reorder returns 200", reorderR.status === 200);
    const listAfterR = await apiFetch(`/api/segments/${seg.id}/rules`);
    const listAfter = (await listAfterR.json()) as {
      data: { id: number; position: number }[];
    };
    check(
      "rule3 now position 1",
      listAfter.data.find((r) => r.id === rule3.id)?.position === 1,
    );
    check(
      "rule1 now position 2",
      listAfter.data.find((r) => r.id === rule1.id)?.position === 2,
    );
    check(
      "rule2 now position 3",
      listAfter.data.find((r) => r.id === rule2.id)?.position === 3,
    );
    const prev7R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const prev7 = (await prev7R.json()) as { count: number | null };
    check(
      "compound count unchanged after reorder = 0",
      prev7.count === 0,
      `got ${prev7.count}`,
    );

    console.log("\n[9] Delete the otherBrand rule — back to 2");
    const delR = await apiFetch(
      `/api/segments/${seg.id}/rules/${rule3.id}`,
      { method: "DELETE" },
    );
    check("delete returns 200", delR.status === 200);
    const prev8R = await apiFetch(`/api/segments/${seg.id}/rules/preview`, {
      method: "POST",
    });
    const prev8 = (await prev8R.json()) as { count: number | null };
    check(
      "after delete = 2 (compound minus invalid AND)",
      prev8.count === 2,
      `got ${prev8.count}`,
    );

    console.log("\n[10] Invalid operator rejected (400)");
    const badOpR = await apiFetch(`/api/segments/${seg.id}/rules`, {
      method: "POST",
      body: JSON.stringify({
        rule_type: "contact_added_in_last_n_days",
        operator: "is_not", // not allowed for time rules
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
        rule_type: "is_clicker_for_brand",
        operator: "is",
        value: 999_999_999,
        is_active: true,
      }),
    });
    check(
      "non-existent brand_id returns 400",
      ghostR.status === 400,
      `got ${ghostR.status}`,
    );

    console.log("\n[13] refresh-stats computes rule_filtered_count");
    const refR = await apiFetch(`/api/segments/${seg.id}/refresh-stats`, {
      method: "POST",
    });
    check("refresh-stats returns 200", refR.status === 200);
    const ref = (await refR.json()) as {
      total_count: number;
      rule_filtered_count: number | null;
    };
    check(
      "rule_filtered_count = 2 (clickers AND probeBrand-clicker)",
      ref.rule_filtered_count === 2,
      `got ${ref.rule_filtered_count}`,
    );
    check(
      "total_count still = 5 (manual count unaffected)",
      ref.total_count === 5,
      `got ${ref.total_count}`,
    );

    console.log("\n[14] segments/list active_rules_count visible");
    const listSegR = await apiFetch("/api/segments/list?pageSize=200");
    const listSeg = (await listSegR.json()) as {
      data: { id: number; active_rules_count?: number }[];
    };
    const row = listSeg.data.find((s) => s.id === seg.id);
    check(
      "segment row has active_rules_count = 2",
      row?.active_rules_count === 2,
      `got ${row?.active_rules_count}`,
    );

    console.log("\n[15] Campaign audience-preview applies rules");
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
      "campaign preview count = 2 (rules narrow audience)",
      campPrev.count === 2,
      `got ${campPrev.count}`,
    );

    console.log("\n[16] Deleting all rules restores manual-membership preview");
    // Delete remaining rules.
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
    const finalPrev = (await finalPrevR.json()) as {
      count: number;
      rule_filtered_count: number | null;
    };
    check(
      "no-rules preview count = 5",
      finalPrev.count === 5,
      `got ${finalPrev.count}`,
    );

    console.log("\n[17] 404 on rules for non-existent segment");
    const ghost404R = await apiFetch("/api/segments/999999999/rules");
    check(
      "non-existent segment rules → 404",
      ghost404R.status === 404,
      `got ${ghost404R.status}`,
    );
  } finally {
    console.log("\nCleanup");
    try {
      // Rules are cascaded by segment delete.
      for (const sid of createdSegmentIds) {
        await db.delete(segments).where(eq(segments.id, sid));
      }
      if (insertedPhones.length > 0) {
        await db
          .delete(clickers)
          .where(inArray(clickers.phone_number, insertedPhones));
        await db
          .delete(contacts)
          .where(inArray(contacts.phone_number, insertedPhones));
      }
      // Brand cascades cover any direct refs.
      for (const bid of createdBrandIds) {
        await db
          .execute(drizzleSql`DELETE FROM brands WHERE id = ${bid}`);
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
