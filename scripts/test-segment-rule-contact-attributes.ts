import "./_env-preload";

import { createServerClient } from "@supabase/ssr";

import {
  AGE_BAND_VALUES,
  GENDER_VALUES,
  INCOME_BAND_VALUES,
  YES_NO_VALUES,
} from "@/lib/validators/segment-rule-types";

// Creates EVERY contact_attributes rule type through the REAL HTTP API, then
// reads each one back and previews the segment.
//
// ⭐ WHY THROUGH HTTP AND NOT BY CALLING THE VALIDATORS. The failure this
// guards against is a rule type registered in some places but not all: it
// validates in Zod, passes ownership, renders in the UI — and the INSERT is
// rejected by the DB CHECK. Only the full route exercises all seven
// registration points at once. `phone_type` / `carrier` shipped uncreatable in
// 0098 precisely because nothing drove the real endpoint.
//
// ⭐ WHERE IT RUNS. Against APP_URL, which MUST be a preview deployment backed
// by the disposable camman-v2 database — this test WRITES (segments and rules),
// and docs/07-conventions.md forbids using production for that. It refuses to
// run against a production-looking host rather than trusting the operator.
//
// Env: APP_URL, SUPABASE_URL, SUPABASE_ANON_KEY, RULE_TEST_EMAIL,
// RULE_TEST_PASSWORD. All are supplied explicitly — it deliberately does NOT
// fall back to .env.local, whose values point at production.

const PROD_HOSTS = ["camman.vercel.app"];

interface Case {
  rule_type: string;
  operator: "is" | "is_not";
  value: unknown;
  note: string;
}

const CASES: Case[] = [
  { rule_type: "gender", operator: "is", value: [...GENDER_VALUES].slice(0, 2), note: "closed set" },
  { rule_type: "age_band", operator: "is", value: ["25_34", "65_plus"], note: "dob RANGE, multi-band" },
  { rule_type: "age_band", operator: "is_not", value: ["18_24"], note: "is_not must stay conservative" },
  { rule_type: "income_band", operator: "is", value: [...INCOME_BAND_VALUES].slice(0, 3), note: "closed set" },
  { rule_type: "has_kids", operator: "is", value: [...YES_NO_VALUES], note: "boolean-as-set, both = known either way" },
  { rule_type: "is_married", operator: "is", value: ["no"], note: "boolean-as-set" },
  { rule_type: "contact_state", operator: "is", value: ["CA", "NY", "TX"], note: "free-text set" },
  { rule_type: "contact_country", operator: "is_not", value: ["CA"], note: "free-text set, is_not" },
  { rule_type: "interest_tag", operator: "is", value: ["ACA", "Medicare", "Home_Services"], note: "extensible tag" },
  { rule_type: "partner_slug", operator: "is", value: ["partner-alpha"], note: "extensible slug" },
];

// Values that MUST be rejected — a guard that only proves acceptance would pass
// even if the endpoint accepted anything at all.
const REJECT_CASES: Case[] = [
  { rule_type: "gender", operator: "is", value: ["F"], note: "not in the closed set" },
  { rule_type: "age_band", operator: "is", value: ["13_17"], note: "under-18 band must not exist" },
  { rule_type: "income_band", operator: "is", value: ["50-75k"], note: "display text, not a code" },
  { rule_type: "has_kids", operator: "is", value: ["maybe"], note: "not yes/no" },
  { rule_type: "contact_state", operator: "is", value: [], note: "empty set" },
  { rule_type: "interest_tag", operator: "is", value: [""], note: "blank entry" },
];

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const appUrl = process.env.APP_URL;
  const supaUrl = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const email = process.env.RULE_TEST_EMAIL;
  const password = process.env.RULE_TEST_PASSWORD;
  if (!appUrl || !supaUrl || !anon || !email || !password) {
    console.error(
      "Set APP_URL, SUPABASE_URL, SUPABASE_ANON_KEY, RULE_TEST_EMAIL, RULE_TEST_PASSWORD.\n" +
        "APP_URL must be a PREVIEW deployment (camman-v2 database) — this test writes.",
    );
    process.exit(1);
  }
  const host = new URL(appUrl).host;
  if (PROD_HOSTS.includes(host)) {
    console.error(`REFUSING to run against production host ${host}. This test writes; use a preview deployment.`);
    process.exit(1);
  }
  console.log(`target ${appUrl}  (host ${host})`);

  const jar = new Map<string, string>();
  const supabase = createServerClient(supaUrl, anon, {
    cookies: {
      getAll: () => Array.from(jar.entries()).map(([name, value]) => ({ name, value })),
      setAll: (cs) => { for (const { name, value } of cs) jar.set(name, value); },
    },
  });
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) { console.error(`sign-in failed: ${error.message}`); process.exit(1); }
  const cookie = Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");

  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${appUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookie, ...(init?.headers ?? {}) },
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  };

  // ── throwaway segment ─────────────────────────────────────────────────────
  const segName = `__rule-type-guard ${new Date().toISOString()}`;
  const created = await api("/api/segments", {
    method: "POST",
    body: JSON.stringify({ name: segName, segment_id: `RTG${Date.now().toString().slice(-8)}` }),
  });
  if (created.status !== 200 && created.status !== 201) {
    console.error(`could not create the test segment: HTTP ${created.status} ${created.text.slice(0, 300)}`);
    process.exit(1);
  }
  const segId = (created.json as { id: number }).id;
  console.log(`test segment ${segId}\n`);

  try {
    console.log("creates every contact_attributes rule type through the API:");
    const madeIds: number[] = [];
    for (const c of CASES) {
      const r = await api(`/api/segments/${segId}/rules`, {
        method: "POST",
        body: JSON.stringify({ rule_type: c.rule_type, operator: c.operator, value: c.value }),
      });
      const ok = r.status === 200 || r.status === 201;
      check(
        `${c.rule_type} ${c.operator} (${c.note})`,
        ok,
        ok ? undefined : `HTTP ${r.status} ${JSON.stringify(r.json ?? r.text).slice(0, 200)}`,
      );
      if (ok) madeIds.push((r.json as { id: number }).id);
    }

    console.log("\nrejects invalid values (proves it is not accepting everything):");
    for (const c of REJECT_CASES) {
      const r = await api(`/api/segments/${segId}/rules`, {
        method: "POST",
        body: JSON.stringify({ rule_type: c.rule_type, operator: c.operator, value: c.value }),
      });
      check(`${c.rule_type} = ${JSON.stringify(c.value)} (${c.note})`, r.status === 400, `HTTP ${r.status}`);
    }

    console.log("\nreads back + evaluates:");
    const list = await api(`/api/segments/${segId}/rules`);
    const rows = ((list.json as { data?: unknown[] })?.data ?? []) as { id: number; rule_type: string }[];
    check(`all ${madeIds.length} rules persisted and read back`, rows.length === madeIds.length,
          `got ${rows.length}`);

    // The preview must actually RUN the emitted SQL for every rule type — this is
    // what catches an emitter that compiles but produces invalid SQL.
    const preview = await api(`/api/segments/${segId}/rules/preview`, { method: "POST" });
    check("rules preview executes the emitted SQL", preview.status === 200,
          `HTTP ${preview.status} ${JSON.stringify(preview.json ?? preview.text).slice(0, 250)}`);
    if (preview.status === 200) console.log(`        ${JSON.stringify(preview.json)}`);
  } finally {
    const del = await api(`/api/segments/${segId}`, { method: "DELETE" });
    console.log(`\ncleanup: deleted test segment ${segId} (HTTP ${del.status})`);
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
