import "./_env-preload";

import { createServerClient } from "@supabase/ssr";

// GUARD for the Overview (/reports) campaign cell's second line: the send
// number(s) behind each row. Two failure modes it exists to catch:
//
//  1. The route stops emitting `phones` at all (a refactor drops the field, the
//     provider_phones join, or the per-campaign distinct set). The column keeps
//     rendering — just without the number — which looks like "these campaigns
//     have no phone assigned" rather than a bug.
//  2. The numbers rendered are not the ones actually configured on the stages.
//     The API's phone values are therefore compared against provider_phones
//     read STRAIGHT FROM THE DB, not against another copy of the same code.
//
// Also checks formatPhoneLast4 itself: short codes stay whole, everything else
// collapses to its last four digits.
//
// Run (dev server on the port BASE_URL names):
//   npx tsx scripts/verify-overview-phone-line.ts
//   BASE_URL=https://camman.vercel.app npx tsx scripts/verify-overview-phone-line.ts

type PhoneRef = { phone_number: string; number_type: string | null };
type Row = {
  stage_id: number | null;
  campaign_id: number;
  campaign_name: string;
  phones: PhoneRef[];
};
type Resp = { data: Row[]; totalCount: number };

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (ok) passed++;
  else failed++;
}

async function main() {
  const { formatPhoneLast4 } = await import("@/lib/phone-validation");

  console.log("\n[1] formatPhoneLast4");
  check('10dlc "+12025550199" → "…0199"', formatPhoneLast4("+12025550199", "10dlc") === "…0199", formatPhoneLast4("+12025550199", "10dlc"));
  check('toll_free "+18885551234" → "…1234"', formatPhoneLast4("+18885551234", "toll_free") === "…1234");
  check('short_code "55512" stays whole', formatPhoneLast4("55512", "short_code") === "55512");
  check("unknown type still collapses", formatPhoneLast4("+12025550199", null) === "…0199");
  check("too-short input falls back to raw", formatPhoneLast4("911", "10dlc") === "911");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const baseUrl = process.env.BASE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;
  if (!supabaseUrl || !anonKey || !email || !password) {
    console.error("Need NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY / TEST_USER_EMAIL / TEST_USER_PASSWORD in .env.local");
    process.exit(1);
  }

  const jar = new Map<string, string>();
  const supabase = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (cs) => cs.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error(`Sign-in failed: ${error.message}`);
    process.exit(1);
  }
  const cookie = [...jar.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
  const api = async (qs: string) => {
    const r = await fetch(`${baseUrl}/api/keitaro/reports?${qs}`, { headers: { Cookie: cookie } });
    if (r.status !== 200) throw new Error(`GET ${qs} → ${r.status}`);
    return (await r.json()) as Resp;
  };

  // A 90-day window so the guard sees real rows even on a quiet week.
  const to = new Date();
  const from = new Date(to.getTime() - 89 * 86_400_000);
  const et = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const range = `from=${et(from)}&to=${et(to)}&pageSize=100`;

  console.log(`\n[2] GET /api/keitaro/reports (${baseUrl}, ${et(from)} → ${et(to)})`);
  const byStage = await api(`${range}&groupBy=stage`);
  const byCampaign = await api(`${range}&groupBy=campaign`);
  check("stage rows returned", byStage.data.length > 0, `${byStage.data.length} rows`);
  check("every stage row carries a phones array", byStage.data.every((r) => Array.isArray(r.phones)));
  check("every campaign row carries a phones array", byCampaign.data.every((r) => Array.isArray(r.phones)));

  const withPhone = byStage.data.filter((r) => r.phones.length > 0);
  // A vacuous pass is the real risk here: all-empty arrays satisfy every check
  // above. Fail loudly instead of reporting green on no data.
  check("at least one stage row actually has a number", withPhone.length > 0, "every row came back with phones: [] — the join or the field is broken");
  console.log(`     ${withPhone.length}/${byStage.data.length} stage rows have a send number`);
  console.log(`     sample: ${withPhone.slice(0, 5).map((r) => `${r.stage_id}:${r.phones.map((p) => formatPhoneLast4(p.phone_number, p.number_type)).join("|")}`).join("  ")}`);

  console.log("\n[3] the numbers match provider_phones in the DB");
  const { db } = await import("@/db/client");
  const { sql } = await import("drizzle-orm");
  const stageIds = withPhone.slice(0, 25).map((r) => r.stage_id!);
  const dbRows = stageIds.length
    ? ((await db.execute(sql`
        SELECT cs.id AS stage_id, pp.phone_number, pp.number_type
        FROM campaign_stages cs
        JOIN provider_phones pp ON pp.id = cs.provider_phone_id
        WHERE cs.id IN ${sql.raw(`(${stageIds.join(",")})`)}
      `)) as unknown as { stage_id: number; phone_number: string; number_type: string }[])
    : [];
  const dbByStage = new Map(dbRows.map((r) => [Number(r.stage_id), r]));
  const mismatched = withPhone
    .slice(0, 25)
    .filter((r) => dbByStage.get(r.stage_id!)?.phone_number !== r.phones[0]?.phone_number);
  check(`API number == DB number for ${stageIds.length} sampled stages`, mismatched.length === 0, mismatched.map((r) => `stage ${r.stage_id}: api ${r.phones[0]?.phone_number} vs db ${dbByStage.get(r.stage_id!)?.phone_number}`).join("; "));

  console.log("\n[4] a campaign row lists the distinct numbers of its stages");
  // Anchored on SQL, not on the route's own grouping: take the stage ids the
  // stage view reported for one campaign, ask Postgres which numbers they use.
  const target = byCampaign.data.find((c) => byStage.data.some((s) => s.campaign_id === c.campaign_id && s.phones.length > 0));
  if (!target) {
    check("found a campaign row to compare", false, "no campaign row had a stage with a number");
  } else {
    const ids = byStage.data.filter((s) => s.campaign_id === target.campaign_id).map((s) => s.stage_id!);
    const rows = (await db.execute(sql`
      SELECT DISTINCT pp.phone_number
      FROM campaign_stages cs
      JOIN provider_phones pp ON pp.id = cs.provider_phone_id
      WHERE cs.id IN ${sql.raw(`(${ids.join(",")})`)}
    `)) as unknown as { phone_number: string }[];
    const expected = [...new Set(rows.map((r) => r.phone_number))].sort();
    const actual = [...new Set(target.phones.map((p) => p.phone_number))].sort();
    check(`campaign ${target.campaign_id} phones match its stages' numbers`, JSON.stringify(expected) === JSON.stringify(actual), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  console.log(`\n${failed === 0 ? "\x1b[32mAll checks passed.\x1b[0m" : `\x1b[31mFAILED: ${failed}\x1b[0m`} (${passed} passed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
