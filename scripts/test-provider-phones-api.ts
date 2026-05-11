import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { provider_phones, sms_providers } from "../db/schema";

type Phone = {
  id: number;
  org_id: string;
  provider_id: number;
  brand_id: number | null;
  phone_number: string;
  country_code: string | null;
  dial_code: string | null;
  local_number: string | null;
  cost_per_sms: string;
  status: "active" | "suspended" | "blocked" | "archived";
  archived_at: string | null;
  created_at: string;
};

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  const dbUrl = process.env.DATABASE_URL!;
  const testEmail = process.env.TEST_USER_EMAIL;
  const testPassword = process.env.TEST_USER_PASSWORD;

  if (!testEmail || !testPassword) {
    console.error(
      "Set TEST_USER_EMAIL and TEST_USER_PASSWORD in .env.local to run this test.",
    );
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
      console.log(
        `  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`,
      );
      failed++;
    }
  }

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);
  const unique = Date.now();
  const providerId = `SMSP-PH-${unique}`;
  let providerNumericId: number | null = null;
  const createdPhoneIds: number[] = [];

  // Build unique-per-run US numbers: +1 (202) 555 0xxx, with last 3 digits from unique.
  const last3 = String(unique).slice(-3);
  const us1Raw = `+1202555${last3}0`;
  const us2Raw = `2025557${last3}`;
  const ukRaw = `+44791112${String(unique).slice(-4)}`;

  try {
    // Bootstrap: create a provider to attach phones to.
    console.log("\n[setup] Create provider");
    const setup = await apiFetch("/api/providers", {
      method: "POST",
      body: JSON.stringify({
        name: "Phones Test Provider",
        sms_provider_id: providerId,
      }),
    });
    if (setup.status !== 201) {
      console.error(`Failed to create provider: ${setup.status}`);
      console.error(await setup.text());
      process.exit(1);
    }
    const provider = (await setup.json()) as { id: number };
    providerNumericId = provider.id;
    const base = `/api/providers/${providerNumericId}/phones`;

    console.log(`\n[1] GET ${base} (empty for new provider)`);
    const r1 = await apiFetch(base);
    check("returns 200", r1.status === 200);
    const body1 = (await r1.json()) as { data: Phone[] };
    check("empty data array", body1.data.length === 0);

    console.log(`\n[2] POST ${base} (valid US E.164 ${us1Raw})`);
    const r2 = await apiFetch(base, {
      method: "POST",
      body: JSON.stringify({ phone_number: us1Raw, cost_per_sms: 0.0125 }),
    });
    check("returns 201", r2.status === 201, `got ${r2.status}`);
    const p2 = (await r2.json()) as Phone;
    check("normalized starts with +1", p2.phone_number.startsWith("+1"));
    check("country_code US", p2.country_code === "US");
    check("dial_code +1", p2.dial_code === "+1");
    check("local_number present", !!p2.local_number);
    check("status active", p2.status === "active");
    createdPhoneIds.push(p2.id);

    console.log(`\n[3] POST ${base} (invalid input 'not-a-phone')`);
    const r3 = await apiFetch(base, {
      method: "POST",
      body: JSON.stringify({ phone_number: "not-a-phone", cost_per_sms: 0.01 }),
    });
    check("returns 400", r3.status === 400);
    const body3 = await r3.json();
    check("code is validation", body3.code === "validation");

    console.log(`\n[4] POST ${base} (duplicate ${us1Raw})`);
    const r4 = await apiFetch(base, {
      method: "POST",
      body: JSON.stringify({ phone_number: us1Raw, cost_per_sms: 0.01 }),
    });
    check("returns 409", r4.status === 409);
    const body4 = await r4.json();
    check("code is duplicate", body4.code === "duplicate");
    check("details.field is phone_number", body4.details?.field === "phone_number");

    console.log(`\n[5] POST ${base} (raw 10-digit US ${us2Raw} auto-prepended)`);
    const r5 = await apiFetch(base, {
      method: "POST",
      body: JSON.stringify({ phone_number: us2Raw, cost_per_sms: 0.01 }),
    });
    check("returns 201", r5.status === 201, `got ${r5.status}`);
    const p5 = (await r5.json()) as Phone;
    check("normalized starts with +1", p5.phone_number.startsWith("+1"));
    createdPhoneIds.push(p5.id);

    console.log(`\n[6] POST ${base} (international UK ${ukRaw})`);
    const r6 = await apiFetch(base, {
      method: "POST",
      body: JSON.stringify({ phone_number: ukRaw, cost_per_sms: 0.04 }),
    });
    check("returns 201", r6.status === 201, `got ${r6.status}`);
    const p6 = (await r6.json()) as Phone;
    check("country_code GB", p6.country_code === "GB");
    check("dial_code +44", p6.dial_code === "+44");
    createdPhoneIds.push(p6.id);

    console.log(`\n[7] PATCH ${base}/${p2.id} (cost_per_sms only)`);
    const r7 = await apiFetch(`${base}/${p2.id}`, {
      method: "PATCH",
      body: JSON.stringify({ cost_per_sms: 0.0099 }),
    });
    check("returns 200", r7.status === 200, `got ${r7.status}`);
    const patched = (await r7.json()) as Phone;
    check("cost updated", Number(patched.cost_per_sms) === 0.0099);

    console.log(`\n[8] PATCH ${base}/${p2.id} attempting phone_number change`);
    const r8 = await apiFetch(`${base}/${p2.id}`, {
      method: "PATCH",
      body: JSON.stringify({ phone_number: "+12025550000" }),
    });
    check("returns 400", r8.status === 400, `got ${r8.status}`);

    console.log(`\n[9] POST ${base}/${p2.id}/status active (idempotent)`);
    const r9 = await apiFetch(`${base}/${p2.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "active" }),
    });
    check("returns 200", r9.status === 200);

    console.log(`\n[10] POST ${base}/${p2.id}/status suspended`);
    const r10 = await apiFetch(`${base}/${p2.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "suspended" }),
    });
    check("returns 200", r10.status === 200);
    check(
      "status suspended",
      ((await r10.json()) as Phone).status === "suspended",
    );

    console.log(`\n[11] POST ${base}/${p2.id}/status blocked`);
    const r11 = await apiFetch(`${base}/${p2.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "blocked" }),
    });
    check("returns 200", r11.status === 200);

    console.log(`\n[12] POST ${base}/${p2.id}/archive`);
    const r12 = await apiFetch(`${base}/${p2.id}/archive`, {
      method: "POST",
    });
    check("returns 200", r12.status === 200);
    check(
      "status archived",
      ((await r12.json()) as Phone).status === "archived",
    );

    console.log(`\n[13] POST ${base}/${p2.id}/status active (while archived)`);
    const r13 = await apiFetch(`${base}/${p2.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "active" }),
    });
    check("returns 409", r13.status === 409, `got ${r13.status}`);
    const body13 = await r13.json();
    check(
      "details.reason is phone_is_archived",
      body13.details?.reason === "phone_is_archived",
    );

    console.log(`\n[14] POST ${base}/${p2.id}/restore`);
    const r14 = await apiFetch(`${base}/${p2.id}/restore`, {
      method: "POST",
    });
    check("returns 200", r14.status === 200);
    check(
      "status active",
      ((await r14.json()) as Phone).status === "active",
    );
  } finally {
    console.log("\nCleanup");
    try {
      for (const id of createdPhoneIds) {
        const d = await db
          .delete(provider_phones)
          .where(eq(provider_phones.id, id))
          .returning({ id: provider_phones.id });
        console.log(`  deleted phone id=${id} (${d.length} row)`);
      }
      if (providerNumericId !== null) {
        const d = await db
          .delete(sms_providers)
          .where(eq(sms_providers.id, providerNumericId))
          .returning({ id: sms_providers.id });
        console.log(
          `  deleted provider id=${providerNumericId} (${d.length} row)`,
        );
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
