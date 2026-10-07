import {
  formatIntakeDigest,
  formatUsd,
  MAX_DIGEST_CHARS,
  type DigestInput,
  type DigestRow,
} from "@/lib/drip/intake-digest-format";

// Hourly partner-intake digest formatter. PURE — no DB, no env, no network:
//   npx tsx --conditions=react-server scripts/test-intake-digest-format.ts
//
// What a red bar here would mean in production: Telegram 400s on malformed HTML
// or >4096 chars and the digest never arrives; or the cost line reads $0.00 for
// a real hour of lookups — the per-batch-delta failure this digest replaces.

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

const RATE = 0.001635;
const row = (partner: string, tag: string, n: number): DigestRow => ({
  partner, tag, received: n, mobile: n - 3, voip: 1, unknown: 1, landline: 1, lookups: n - 1,
});
const base = (rows: DigestRow[], over: Partial<DigestInput> = {}): DigestInput => ({
  windowLabel: "13:00–14:00 ET · Tue 7 Oct",
  rows,
  rate: RATE,
  rateNote: "$0.001635 per lookup, calibrated from $1002.84 of metered balance",
  balanceUsd: 123.4567,
  invariant: { day: "2026-10-07", breaks: [] },
  firstDigestNote: null,
  manual: false,
  ...over,
});

// 1. Zero intake → nothing to send.
check("no rows → no message", formatIntakeDigest(base([])).length === 0);

// 2. One partner x tag → compact lines, no table.
{
  const m = formatIntakeDigest(base([row("pml", "aca", 412)]));
  check("single → one message", m.length === 1);
  check("single → no <pre> table", !m[0].includes("<pre>"));
  check("single → leads + mobile line", m[0].includes("<b>pml / aca</b>: 412 leads · 409 mobile"), m[0]);
  check("single → voip/unknown/landline compact", m[0].includes("voip 1 · unknown 1 · landline 1"));
  check("single → lookups + cost at rate", m[0].includes(`Lookups: 411 · cost ${formatUsd(411 * RATE)}`), m[0]);
  check("footer states the rate used", m[0].includes("411 lookups × $0.001635 per lookup"), m[0]);
  check("footer has Telnyx balance once", m[0].split("Telnyx balance").length === 2 && m[0].includes("$123.46"));
  check("no warning when invariant holds", !m[0].includes("Day-sum"));
}

// 3. Several → monospace table with totals row.
{
  const rows = [row("pml", "aca", 412), row("pml", "", 10), row("abc", "medicare", 50)];
  const m = formatIntakeDigest(base(rows));
  check("multi → one message", m.length === 1);
  const pre = m[0].slice(m[0].indexOf("<pre>") + 5, m[0].indexOf("</pre>"));
  const lines = pre.split("\n");
  check("multi → header columns", /^Partner +Tag +Leads +Mobile +Lookups +Cost$/.test(lines[0]), lines[0]);
  check("multi → sorted by partner", lines[1].startsWith("abc"), lines[1]);
  check("untagged rendered", pre.includes("(untagged)"));
  const total = lines[lines.length - 1];
  check("multi → TOTAL row sums", /^TOTAL +472 +463 +469 +\$0\.7668$/.test(total), total);
  check("separator before TOTAL", /^-+$/.test(lines[lines.length - 2]));
  const lens = new Set(lines.filter((l) => !/^-+$/.test(l)).map((l) => l.length));
  check("Cost column right-aligned (equal line lengths)", lens.size === 1, [...lens].join(","));
  check("per-row other line types", m[0].includes("abc/medicare: voip 1 · unknown 1 · landline 1"));
}

// 4. HTML escaping — padding computed on the raw string, escaping after.
{
  const m = formatIntakeDigest(base([row("p&q", "<x>", 5), row("pml", "aca", 5)]));
  check("escaped &", m[0].includes("p&amp;q") && !m[0].includes("p&q "));
  check("escaped <>", m[0].includes("&lt;x&gt;") && !m[0].includes("<x>"));
}

// 5. Day-sum invariant warning.
{
  const m = formatIntakeDigest(
    base([row("pml", "aca", 5)], {
      invariant: {
        day: "2026-10-08",
        breaks: [{ partner: "pml", tag: "aca", column: "received", hourlySum: 410, daily: 412 }],
      },
    }),
  );
  check("warning line on divergence", m[0].includes("⚠️ Day-sum check FAILED for 2026-10-08") && m[0].includes("pml/aca received 410≠412"), m[0]);
  const n = formatIntakeDigest(base([row("pml", "aca", 5)], { invariant: null }));
  check("no warning when not checked", !n[0].includes("Day-sum"));
}

// 6. First-digest note + manual marker + balance failure.
{
  const m = formatIntakeDigest(
    base([row("pml", "aca", 5)], { firstDigestNote: "First hourly digest. X", manual: true, balanceUsd: null }),
  );
  check("first-digest note in footer", m[0].includes("ℹ️ First hourly digest. X"));
  check("manual re-run marked", m[0].includes("(manual re-run)"));
  check("balance n/a", m[0].includes("Telnyx balance: n/a"));
}

// 7. Small costs never print as $0.00.
check("2 lookups ≠ $0.00", formatUsd(2 * RATE) === "$0.0033", formatUsd(2 * RATE));
check("large cost 2 decimals", formatUsd(12.3456) === "$12.35");

// 8. Oversized → split by partner, every part under the limit.
{
  const rows: DigestRow[] = [];
  for (let p = 0; p < 40; p++) for (let t = 0; t < 4; t++) rows.push(row(`partner${p}`, `tag${t}`, 100 + p));
  const m = formatIntakeDigest(base(rows));
  check("oversized → several messages", m.length > 1, String(m.length));
  check("every part ≤ MAX_DIGEST_CHARS", m.every((x) => x.length <= MAX_DIGEST_CHARS), m.map((x) => x.length).join(","));
  check("parts numbered", m.every((x, i) => x.includes(`(part ${i + 1}/${m.length})`)));
  const owner = new Map<string, Set<number>>();
  m.forEach((x, i) => {
    for (const mm of x.matchAll(/^(partner\d+) /gm)) owner.set(mm[1], (owner.get(mm[1]) ?? new Set()).add(i));
  });
  check("no partner split across parts", owner.size === 40 && [...owner.values()].every((s) => s.size === 1));
  const last = m[m.length - 1];
  const leads = rows.reduce((a, r) => a + r.received, 0);
  check("grand total on last part only", last.includes(`TOTAL (all parts)</b>: ${leads} leads`) && m.slice(0, -1).every((x) => !x.includes("TOTAL")));
  check("footer on last part only", last.includes("Telnyx balance") && m.slice(0, -1).every((x) => !x.includes("Telnyx balance")));
}

// 9. One partner bigger than a message → its rows split, still under limit.
{
  const rows: DigestRow[] = [];
  for (let t = 0; t < 150; t++) rows.push(row("pml", `tag${String(t).padStart(3, "0")}`, 100));
  const m = formatIntakeDigest(base(rows));
  check("giant partner → split", m.length > 1 && m.every((x) => x.length <= MAX_DIGEST_CHARS), m.map((x) => x.length).join(","));
  const tags = m.join("\n").match(/^pml +tag\d+/gm) ?? [];
  check("giant partner → no row lost", tags.length === 150, String(tags.length));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
