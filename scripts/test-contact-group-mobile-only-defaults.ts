// scripts/test-contact-group-mobile-only-defaults.ts — pure (no DB), part of check:guards.
//
// Migration 0222 (owner-approved 2026-10-23): contact groups are mobile-only by
// default and toll_free joins the line-type gate. A column default is only a
// backstop — every app create path must pass EXPLICIT values, and the UI create
// must not be able to omit them (CLAUDE.md §11b: a parameter that decides who
// is selected is required, never optional with a default).
//
//   V1–V3  the create schema requires all three flags; PATCH stays partial
//   C1     drip partner×tag groups are created false/false/false
//   C2     drip SYSTEM groups are created true/true/true (owner decision 2)
//   C3     the UI POST passes the parsed flags through, no `?? true`
//   F1–F2  the form starts VoIP + toll-free off, unknown ON (owner ruling: a
//          fresh CSV upload is 'unknown' until looked up), and shows a toll-free box
//   G1–G2  the shared gate and the drip routing predicate both gate toll_free
//   R1     the list API and both pages carry allow_toll_free
import { readFileSync } from "node:fs";

import { contactGroupCreateSchema, contactGroupUpdateSchema } from "@/lib/validators/contact-groups";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const src = (f: string) => strip(readFileSync(f, "utf8"));
const flat = (s: string) => s.replace(/\s+/g, " ");

console.log("Contact groups — mobile-only defaults (0222)");
const base = { name: "g", contact_group_id: "g-1" };
const flags = { allow_voip: false, allow_unknown: true, allow_toll_free: false };
for (const k of Object.keys(flags) as (keyof typeof flags)[]) {
  const body: Record<string, unknown> = { ...base, ...flags };
  delete body[k];
  bar(`V1 create refuses a body without ${k}`, !contactGroupCreateSchema.safeParse(body).success);
}
const ok = contactGroupCreateSchema.safeParse({ ...base, ...flags });
bar("V2 create accepts all three and carries them", ok.success && ok.data.allow_toll_free === false && ok.data.allow_unknown === true,
  JSON.stringify(ok.success ? ok.data : ok.error.issues[0]));
bar("V3 PATCH accepts allow_toll_free alone", contactGroupUpdateSchema.safeParse({ allow_toll_free: false }).success);

const groups = flat(src("lib/drip/groups.ts"));
const insertOf = (fn: string) => groups.slice(groups.indexOf(`export async function ${fn}(`)).split("RETURNING id")[0];
const tagIns = insertOf("ensurePartnerTagGroup");
const sysIns = insertOf("ensureDripGroup");
bar("C1 ensurePartnerTagGroup inserts allow_voip/allow_unknown/allow_toll_free = false",
  /allow_voip, allow_unknown, allow_toll_free\)/.test(tagIns) && /false, false, false\)/.test(tagIns), tagIns.slice(-260));
bar("C1 …and its ON CONFLICT never touches the flags", !/DO UPDATE[^;]*allow_/.test(tagIns));
bar("C2 ensureDripGroup inserts them = true (system groups hold every drip lead)",
  /allow_voip, allow_unknown, allow_toll_free\)/.test(sysIns) && /true, true, true\)/.test(sysIns), sysIns.slice(-260));

const post = flat(src("app/api/contact-groups/route.ts"));
bar("C3 UI POST passes the parsed flags through with no `?? true` fallback",
  /allow_voip: parsed\.data\.allow_voip,/.test(post) && /allow_unknown: parsed\.data\.allow_unknown,/.test(post)
    && /allow_toll_free: parsed\.data\.allow_toll_free,/.test(post) && !/allow_\w+ \?\? true/.test(post));

const form = flat(src("components/contact-groups/contact-group-form.tsx"));
bar("F1 form starts VoIP off, unknown on, toll-free off",
  /allow_voip: initialValues\?\.allow_voip \?\? false/.test(form) && /allow_unknown: initialValues\?\.allow_unknown \?\? true/.test(form)
    && /allow_toll_free: initialValues\?\.allow_toll_free \?\? false/.test(form));
bar("F2 form shows a toll-free checkbox", /name: "allow_toll_free", label: "Allow toll-free numbers"/.test(form));

const gate = flat(src("lib/contact-groups/line-type-gate.ts"));
bar("G1 shared gate: toll_free in the candidate set, the short-circuit and the per-group predicate",
  /line_type IN \('voip', 'unknown', 'toll_free'\)/.test(gate) && /lt_any\.allow_toll_free = false/.test(gate)
    && /lt_g\.allow_toll_free = false AND lt_c\.line_type = 'toll_free'/.test(gate));
const routing = flat(src("lib/drip/routing-eval.ts"));
bar("G2 drip routing predicate gates toll_free too",
  /lt_g\.allow_toll_free = false AND le\.line_type = 'toll_free'/.test(routing));

const list = src("app/api/contact-groups/list/route.ts");
const pages = ["app/(protected)/contact-groups/page.tsx", "app/(protected)/contact-groups/[id]/page.tsx"].map(src);
bar("R1 list API selects allow_toll_free; both pages type and pass it",
  /allow_toll_free: contact_groups\.allow_toll_free/.test(list)
    && pages.every((p) => /allow_toll_free: boolean;/.test(p) && /allow_toll_free: (editing|group)\.allow_toll_free/.test(p)));

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
