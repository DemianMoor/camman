import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { contact_groups, contacts } from "../db/schema";

type SegmentGroup = {
  id: number;
  contact_group_id: string;
  name: string;
  description: string | null;
  color: string | null;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  org_id: string;
};
type SegmentGroupListRow = SegmentGroup & { contact_count: number };
type ListResponse = { data: SegmentGroupListRow[]; totalCount: number };

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

  const createdIds: number[] = [];
  const unique = Date.now();
  const slug = `SG-${unique}`;

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);

  try {
    console.log("\n[1] GET /api/contact-groups/list (initial)");
    const r1 = await apiFetch("/api/contact-groups/list");
    check("returns 200", r1.status === 200);
    const body1 = (await r1.json()) as ListResponse;
    const initialCount = body1.totalCount;

    console.log("\n[2] POST /api/contact-groups (create)");
    const r2 = await apiFetch("/api/contact-groups", {
      method: "POST",
      body: JSON.stringify({
        name: "High-value customers",
        contact_group_id: slug,
        description: "Customers with LTV above $500",
        color: "#A855F7",
      }),
    });
    check("returns 201", r2.status === 201, `got ${r2.status}`);
    const sg = (await r2.json()) as SegmentGroup;
    createdIds.push(sg.id);

    console.log("\n[3] POST /api/contact-groups (duplicate)");
    const r3 = await apiFetch("/api/contact-groups", {
      method: "POST",
      body: JSON.stringify({ name: "Dup", contact_group_id: slug }),
    });
    check("returns 409", r3.status === 409);
    const body3 = await r3.json();
    check("code is duplicate", body3.code === "duplicate");
    check(
      "details.field is contact_group_id",
      body3.details?.field === "contact_group_id",
    );

    console.log(`\n[4] GET /api/contact-groups/${sg.id}`);
    const r4 = await apiFetch(`/api/contact-groups/${sg.id}`);
    check("returns 200", r4.status === 200);

    console.log("\n[5] GET /api/contact-groups/99999");
    const r5 = await apiFetch("/api/contact-groups/99999");
    check("returns 404", r5.status === 404);
    const body5 = await r5.json();
    check("code is not_found", body5.code === "not_found");
    check(
      "details.entity is contact_group",
      body5.details?.entity === "contact_group",
    );

    console.log(`\n[6] PATCH /api/contact-groups/${sg.id}`);
    const r6 = await apiFetch(`/api/contact-groups/${sg.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "High-value (renamed)" }),
    });
    check("returns 200", r6.status === 200);

    console.log("\n[7] GET /api/contact-groups/list (contact_count placeholder)");
    const r7 = await apiFetch("/api/contact-groups/list?pageSize=100");
    const body7 = (await r7.json()) as ListResponse;
    const found = body7.data.find((g) => g.id === sg.id);
    // Step-6 TODO: real count once segments table exists.
    check(
      "contact_count is 0 (placeholder until step 6)",
      found?.contact_count === 0,
      `got ${found?.contact_count}`,
    );

    console.log(`\n[8] POST /api/contact-groups/${sg.id}/archive`);
    const r8 = await apiFetch(`/api/contact-groups/${sg.id}/archive`, {
      method: "POST",
    });
    check("returns 200", r8.status === 200);

    console.log("\n[9] GET /api/contact-groups/list (archived hidden)");
    const r9 = await apiFetch("/api/contact-groups/list");
    const body9 = (await r9.json()) as ListResponse;
    check(
      "archived not in default list",
      !body9.data.some((g) => g.id === sg.id),
    );

    console.log(`\n[10] POST /api/contact-groups/${sg.id}/restore`);
    const r10 = await apiFetch(`/api/contact-groups/${sg.id}/restore`, {
      method: "POST",
    });
    check("returns 200", r10.status === 200);

    console.log(`\n    final delta = ${body9.totalCount - initialCount}`);

    // ====================================================================
    // 6.5p2: contact-group child endpoints (list / add / remove)
    // ====================================================================

    // 10-digit national format (`+1 213 XXXXXXX`) — valid US per libphonenumber.
    const base = (Number(String(unique).slice(-6)) % 9_000) + 1_000;
    const childPhones = [0, 1, 2, 3].map(
      (i) => `+1213700${String(base + i).padStart(4, "0")}`,
    );

    console.log(`\n[11] POST /api/contact-groups/${sg.id}/contacts/add — adds 4 contacts`);
    const r11 = await apiFetch(
      `/api/contact-groups/${sg.id}/contacts/add`,
      {
        method: "POST",
        body: JSON.stringify({ phones: childPhones.join("\n") }),
      },
    );
    check("add returns 201", r11.status === 201);
    const s11 = (await r11.json()) as {
      submitted: number;
      valid: number;
      contacts_created: number;
      groups_applied: number;
    };
    check(
      "add response: 4 valid",
      s11.valid === 4,
      `got valid=${s11.valid}`,
    );
    check(
      "add response: 4 groups_applied",
      s11.groups_applied === 4,
      `got groups_applied=${s11.groups_applied}`,
    );

    console.log(`\n[12] GET /api/contact-groups/${sg.id}/contacts — lists 4`);
    const r12 = await apiFetch(
      `/api/contact-groups/${sg.id}/contacts?pageSize=20`,
    );
    check("contacts list returns 200", r12.status === 200);
    const body12 = (await r12.json()) as {
      data: { id: string; phone_number: string; other_groups: { id: number }[] }[];
      totalCount: number;
    };
    check(
      "totalCount = 4",
      body12.totalCount === 4,
      `got ${body12.totalCount}`,
    );
    check(
      "every row carries other_groups array (current group excluded)",
      body12.data.every(
        (r) =>
          Array.isArray(r.other_groups) &&
          !r.other_groups.some((g) => g.id === sg.id),
      ),
    );

    console.log("\n[13] Re-add the same phones — idempotent, groups_applied = 0");
    const r13 = await apiFetch(
      `/api/contact-groups/${sg.id}/contacts/add`,
      {
        method: "POST",
        body: JSON.stringify({ phones: childPhones.join("\n") }),
      },
    );
    const s13 = (await r13.json()) as {
      contacts_created: number;
      groups_applied: number;
    };
    check(
      "re-add: contacts_created = 0 (already exist)",
      s13.contacts_created === 0,
      `got ${s13.contacts_created}`,
    );
    check(
      "re-add: groups_applied = 0 (idempotent)",
      s13.groups_applied === 0,
      `got ${s13.groups_applied}`,
    );

    console.log(`\n[14] POST /api/contact-groups/${sg.id}/contacts/remove — removes 2`);
    const r14 = await apiFetch(
      `/api/contact-groups/${sg.id}/contacts/remove`,
      {
        method: "POST",
        body: JSON.stringify({
          phones: childPhones.slice(0, 2).join("\n"),
        }),
      },
    );
    check("remove returns 200", r14.status === 200);
    const s14 = (await r14.json()) as { removed: number; not_in_group: number };
    check("removed = 2", s14.removed === 2, `got ${s14.removed}`);

    console.log("\n[15] Remove same phones again — not_in_group = 2, removed = 0");
    const r15 = await apiFetch(
      `/api/contact-groups/${sg.id}/contacts/remove`,
      {
        method: "POST",
        body: JSON.stringify({
          phones: childPhones.slice(0, 2).join("\n"),
        }),
      },
    );
    const s15 = (await r15.json()) as { removed: number; not_in_group: number };
    check("removed = 0 (already gone)", s15.removed === 0);
    check(
      "not_in_group = 2",
      s15.not_in_group === 2,
      `got ${s15.not_in_group}`,
    );

    console.log("\n[16] Remove a phone that's not in the contacts table — not_found counted");
    // A valid US phone we have NOT inserted in this run — should count as not_found.
    const ghostPhone = `+1213999${String(base).padStart(4, "0")}`;
    const r16 = await apiFetch(
      `/api/contact-groups/${sg.id}/contacts/remove`,
      {
        method: "POST",
        body: JSON.stringify({ phones: ghostPhone }),
      },
    );
    const s16 = (await r16.json()) as { not_found: number };
    check("not_found >= 1", s16.not_found >= 1, `got ${s16.not_found}`);

    console.log("\n[17] 404 on /contacts for non-existent group");
    const r17 = await apiFetch("/api/contact-groups/999999999/contacts");
    check("ghost group → 404", r17.status === 404, `got ${r17.status}`);

    // Clean up the contacts we created via the add endpoint.
    await db.delete(contacts).where(inArray(contacts.phone_number, childPhones));
  } finally {
    console.log("\nCleanup");
    try {
      for (const id of createdIds) {
        const d = await db
          .delete(contact_groups)
          .where(eq(contact_groups.id, id))
          .returning({ id: contact_groups.id });
        console.log(`  deleted id=${id} (${d.length} row)`);
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
