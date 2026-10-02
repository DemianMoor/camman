// Task 2 T5 — the preview ROUTE in two parts, over HTTP, against a running
// server (npm run dev:preview).
//
//   P1 a request WITHOUT `part` keeps today's top-level response shape
//      (operator API tokens call this route);
//   P2 `part: "base"` / `part: "audience"` answer { part, data };
//   P3 combinePreviewParts(base, audience) equals the part-less response on
//      every recipe, field by field — the client merges with the same function;
//   P4 the audience part carries NO group-level numbers (they come from base).
// Writes nothing.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-preview-parts-route.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";

import { combinePreviewParts } from "@/lib/audience-preview-parts";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const leaves = (o: unknown, path = "", out = new Map<string, unknown>()) => {
  if (o !== null && typeof o === "object")
    for (const k of Object.keys(o as object))
      leaves((o as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
  else out.set(path, o);
  return out;
};
const diff = (a: unknown, b: unknown) => {
  const la = leaves(a);
  const lb = leaves(b);
  return [...new Set([...la.keys(), ...lb.keys()])].filter((k) => la.get(k) !== lb.get(k));
};

async function main() {
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  const jar = new Map<string, string>();
  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cs) => cs.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { error } = await sb.auth.signInWithPassword({
    email: process.env.TEST_USER_EMAIL!,
    password: process.env.TEST_USER_PASSWORD!,
  });
  if (error) throw error;
  const api = async (path: string, init?: RequestInit) =>
    fetch(`${appUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
      },
    });
  // The LARGEST groups, so the recipes have real audiences (P3b).
  const groups = ((await (await api("/api/contact-groups/list?pageSize=100")).json()) as { data: { id: number; contact_count?: number }[] }).data
    .filter((g) => (g.contact_count ?? 0) > 0)
    .sort((a, b) => (b.contact_count ?? 0) - (a.contact_count ?? 0))
    .slice(0, 3);
  const segs = ((await (await api("/api/segments/list?pageSize=5")).json()) as { data: { id: number }[] }).data;
  bar("the preview org has groups and segments to preview", groups.length > 0 && segs.length > 0);

  const recipes: Record<string, unknown>[] = [
    { audience_contact_group_ids: [groups[0].id] },
    { audience_segment_ids: [segs[0].id] },
    { audience_segment_ids: [segs[0].id], audience_contact_group_ids: groups.slice(0, 2).map((g) => g.id) },
    { audience_contact_group_ids: groups.map((g) => g.id), audience_cap: 5 },
    { audience_contact_group_ids: [groups[0].id], exclude_in_use_contacts: true },
  ].map((r) => ({
    audience_filters: { include_no_status: true, include_not_clicked: true, include_clickers: true, include_opt_in: true, lifecycle_statuses: ["hot", "warm", "cold"] },
    exclude_in_use_contacts: false,
    ...r,
  }));

  let shapeOk = true;
  let envelopeOk = true;
  let noGroupLevel = true;
  const mism: string[] = [];
  let nonEmpty = 0;
  for (const [i, r] of recipes.entries()) {
    const post = async (body: Record<string, unknown>) => {
      const res = await api("/api/campaigns/audience-preview", { method: "POST", body: JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const whole = await post(r);
    const base = await post({ ...r, part: "base" });
    const aud = await post({ ...r, part: "audience" });
    shapeOk &&= whole.status === 200 && typeof whole.json.total_matching === "number" && !("part" in whole.json);
    envelopeOk &&= base.json.part === "base" && aud.json.part === "audience";
    const ad = aud.json.data as Record<string, unknown>;
    noGroupLevel &&= !("excluded_for_optout" in ad);
    if (Number(whole.json.total_matching) > 0) nonEmpty++;
    const filters = r.audience_filters as { lifecycle_statuses?: string[] };
    const d = diff(
      combinePreviewParts(base.json.data as never, ad as never, filters.lifecycle_statuses ?? []),
      whole.json,
    );
    if (d.length) mism.push(`recipe ${i + 1}: ${d.join(",")}`);
  }
  bar("P1 a request without `part` keeps today's top-level shape", shapeOk);
  bar("P2 part requests answer { part, data }", envelopeOk);
  bar("P3 base + audience (combined) = the part-less response, every recipe", mism.length === 0, mism.join("; ") || `${recipes.length} recipes, 0 differences`);
  bar("P3b …not all empty", nonEmpty > 0, `${nonEmpty} of ${recipes.length} non-empty`);
  bar("P4 the audience part carries no group-level numbers", noGroupLevel);

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
