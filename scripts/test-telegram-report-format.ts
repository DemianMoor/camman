import { readFileSync } from "node:fs";

import {
  capped,
  dailyMessage,
  eventLines,
  hourlyMessage,
  MAX_EVENT_LINES,
  MAX_MESSAGE_CHARS,
} from "@/lib/reporting/telegram-report-format";
import { pluralizeLabel } from "@/lib/reporting/event-columns";
import type { ReportMetrics } from "@/lib/reporting/report-snapshot";

// Renders the daily + hourly messages from the ground-truth metrics pulled via
// the Supabase MCP (2026-07-01 final, 2026-07-02 so far), asserting the format
// and the two n/a branches (spend==0 ⇒ ROI n/a; delivered==0 ⇒ ratio n/a).
//
// PURE — no DB, no env, no network. Run:
//   npx tsx --conditions=react-server scripts/test-telegram-report-format.ts
//
// ⭐ WHY THE T-BARS BELOW ARE NOT COSMETIC. The scheduled report posts with
// parse_mode "HTML" through sendTelegramHtml, which THROWS on any non-2xx;
// classify() calls a 400 "permanent", so the cron returns 500 — and does exactly
// the same thing every hour afterwards, because nothing about the input changes.
// Telegram 400s both on malformed markup and on text over 4096 characters, and
// event_types.label is free text with no CHECK and no UI. Escaping and the cap
// are therefore the difference between a report and a permanent outage.

// The three ORIGINAL fixtures keep an EMPTY registry, which is the point: with
// no event types configured the three whole-message goldens below must be
// byte-identical to what this report sent before Phase 5 existed.
const yesterday: ReportMetrics = {
  sales: 12,
  revenue: 900,
  spend: 392.26,
  optOuts: 853,
  delivered: 38502,
  roiPct: ((900 - 392.26) / 392.26) * 100,
  events: {},
  eventTypes: [],
  unmapped: 0,
  manualTopup: 0,
};
const today: ReportMetrics = {
  sales: 1,
  revenue: 75,
  spend: 0,
  optOuts: 9,
  delivered: 0,
  roiPct: null, // spend == 0
  events: {},
  eventTypes: [],
  unmapped: 0,
  manualTopup: 0,
};

let failures = 0;
function eq(name: string, got: string, expected: string) {
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"} ${name}`);
  if (!ok) {
    console.log("  got:\n" + got);
    console.log("  expected:\n" + expected);
  }
}

// Boolean bars, beside eq (same counter). The eq assertions above are
// whole-message goldens and stay — they are worth more than the bars that would
// replace them.
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗ FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const daily = dailyMessage("Wed 1 Jul", yesterday);
eq(
  "daily",
  daily,
  [
    "📊 <b>CamMan — Wed 1 Jul</b> (final, ET)",
    "Sales: 12",
    "Revenue: $900.00",
    "Spend: $392.26",
    "ROI: +129.4%",
    "Net Profit: $507.74",
    "Opt-outs: 853 (2.2% of 38,502 delivered)",
  ].join("\n"),
);

const hourly = hourlyMessage("Thu 2 Jul", today, 392.26);
eq(
  "hourly (spend==0 ⇒ ROI n/a, delivered==0 ⇒ ratio n/a)",
  hourly,
  [
    "⏱ <b>CamMan — Thu 2 Jul</b> (so far, ET)",
    "Sales: 1",
    "Revenue: $75.00",
    "Spend: $0.00",
    "ROI: n/a",
    "Net Profit: $75.00",
    "Opt-outs: 9 (n/a — 0 delivered)",
    "Yesterday spend: $392.26",
  ].join("\n"),
);

// Negative net profit renders as -$X.XX (minus before the $).
const loss: ReportMetrics = {
  sales: 2,
  revenue: 100,
  spend: 250,
  optOuts: 5,
  delivered: 1000,
  roiPct: ((100 - 250) / 250) * 100,
  events: {},
  eventTypes: [],
  unmapped: 0,
  manualTopup: 0,
};
eq(
  "daily (net loss ⇒ -$150.00, ROI -60.0%)",
  dailyMessage("Fri 3 Jul", loss),
  [
    "📊 <b>CamMan — Fri 3 Jul</b> (final, ET)",
    "Sales: 2",
    "Revenue: $100.00",
    "Spend: $250.00",
    "ROI: -60.0%",
    "Net Profit: -$150.00",
    "Opt-outs: 5 (0.5% of 1,000 delivered)",
  ].join("\n"),
);

// ── Phase 5: the per-event split ────────────────────────────────────────────

const S = (key: string, label: string) => ({ key, label });

// ⚠️ BASE CARRIES A TWO-TYPE REGISTRY, and it has to: T2, T3 and T11 assert
// against lines they never configure, so an empty BASE.eventTypes makes all
// three assert over an EMPTY array — T2/T3 comparing "" to a rendered line and
// T11 reading 0 where it demands 2. T12 clears it explicitly, which is what
// proves the empty-registry case.
const BASE: ReportMetrics = {
  sales: 12,
  revenue: 900,
  spend: 392.26,
  optOuts: 853,
  delivered: 38502,
  roiPct: ((900 - 392.26) / 392.26) * 100,
  events: {},
  eventTypes: [S("registration", "Registrations"), S("purchase", "Purchases")],
  unmapped: 0,
  manualTopup: 0,
};
const M = (over: Partial<ReportMetrics> = {}): ReportMetrics => ({ ...BASE, ...over });
const TEN_TYPES = Array.from({ length: 10 }, (_, i) => S(`t${i}`, `Type ${i}`));
// ⭐ 600-CHARACTER LABELS, AND THE LENGTH IS THE WHOLE POINT. MAX_EVENT_LINES is
// 6, so a registry of 200 SHORT-labelled types renders ~950 characters against a
// 3500 cap and T8 could never go red — a cap bar that cannot reach the cap
// proves nothing. Six lines of ~600 characters is ~3,600 and clears it.
const MANY_LONG = Array.from({ length: 200 }, (_, i) => S(`l${i}`, `${"Label".repeat(120)} ${i}`));
// ⭐ THE ENTITY FIXTURE. Every label is `&`-dense, so an arbitrary slice would
// very likely land inside an `&amp;`.
const AMP_LONG = Array.from({ length: 200 }, (_, i) => S(`a${i}`, `${"A & B ".repeat(100)}${i}`));

const MONEY_LINES = ["Revenue:", "Spend:", "ROI:", "Net Profit:", "Opt-outs:"];
/** A dangling `&` or `&am` at the very end is the 400-shaped failure. */
const DANGLING_ENTITY = /&[a-z]{0,6}$/i;

check(
  "T1 ⭐ one line per registry type, in registry order, even at zero",
  eventLines(M({ eventTypes: [S("registration", "Registrations"), S("purchase", "Purchases")], events: {} }))
    .slice(0, 2)
    .join("|") === "Registrations: 0|Purchases: 0",
);
check(
  "T2 a revenue-bearing type prints its money, a $0 type does not",
  eventLines(
    M({
      events: {
        purchase: { n: 3, revenue: 120, pending_revenue: 0 },
        registration: { n: 9, revenue: 0, pending_revenue: 0 },
      },
    }),
  ).join("|") === "Registrations: 9|Purchases: 3 · $120.00",
);
check(
  "T3 ⭐ held money is named as pending, never added to the amount",
  eventLines(M({ events: { purchase: { n: 3, revenue: 120, pending_revenue: 40 } } }))[1] ===
    "Purchases: 3 · $120.00 ($40.00 pending)",
);
check(
  "T4 ⭐ a label containing HTML is ESCAPED (and pluralised BEFORE escaping, so the 's' can never land inside an entity)",
  eventLines(M({ eventTypes: [S("purchase", "<b>Buy</b> & win")] }))[0].startsWith(
    "&lt;b&gt;Buy&lt;/b&gt; &amp; wins: ",
  ),
  eventLines(M({ eventTypes: [S("purchase", "<b>Buy</b> & win")] }))[0],
);
check(
  "T4a2 ⭐⭐ a label ENDING in '&' pluralises to '&amp;s', never the malformed '&amps;' — the order of the two steps, asserted on the case that breaks it",
  (() => {
    const line = eventLines(M({ eventTypes: [S("purchase", "Buy &")] }))[0];
    return line.startsWith("Buy &amp;s: ") && !line.includes("&amps;");
  })(),
  eventLines(M({ eventTypes: [S("purchase", "Buy &")] }))[0],
);
check(
  "T4b ⭐ an emoji label survives intact (escapeHtml touches only & < >)",
  eventLines(M({ eventTypes: [S("purchase", "💰 Buy")] }))[0].startsWith("💰 Buys: "),
  eventLines(M({ eventTypes: [S("purchase", "💰 Buy")] }))[0],
);
check(
  "T4c ⭐ a single label too long to fit is DROPPED WHOLE and announced — never sliced mid-entity",
  (() => {
    const m = dailyMessage("Tue 1 Sep", M({ eventTypes: [S("purchase", "&<>".repeat(2000))] }));
    return (
      m.length <= MAX_MESSAGE_CHARS &&
      m.includes("+1 more event type\n") &&
      !m.split("\n").some((l) => DANGLING_ENTITY.test(l)) &&
      MONEY_LINES.every((s) => m.includes(s))
    );
  })(),
);
check(
  "T4d ⭐ a NEWLINE inside a label cannot forge an extra line (it would read as a money line)",
  (() => {
    const lines = eventLines(M({ eventTypes: [S("purchase", "Buy\nRevenue: $999,999.00")] }));
    return lines.length === 1 && lines[0] === "Buy Revenue: $999,999.00s: 0";
  })(),
  eventLines(M({ eventTypes: [S("purchase", "Buy\nRevenue: $999,999.00")] }))[0],
);
check(
  // The KEY is pluralised too, deliberately: this line is a COUNT of events
  // wherever the name came from, and a fallback that reads singular beside five
  // plural lines looks like a different kind of row rather than a missing label.
  "T4e ⭐ an empty label falls back to the key rather than rendering a nameless \": 0\"",
  eventLines(M({ eventTypes: [S("purchase", "   ")] }))[0] === "purchases: 0",
  eventLines(M({ eventTypes: [S("purchase", "   ")] }))[0],
);
check(
  "T4f ⭐ a label that FITS is kept whole — an `&`-dense line is present in full, entity by entity",
  (() => {
    const label = "A & B ".repeat(50); // 300 chars raw → 500 escaped; fits
    // .trimEnd(): eventLabel collapses and TRIMS whitespace, THEN pluralises
    // (the trailing "B" earns an "s"), and escapes last.
    const line = `${"A &amp; B ".repeat(50).trimEnd()}s: 0`;
    const m = dailyMessage("Tue 1 Sep", M({ eventTypes: [S("purchase", label)] }));
    return m.includes(`\n${line}\n`) && m.length <= MAX_MESSAGE_CHARS;
  })(),
);
check(
  "T5 ⭐ a label containing HTML survives the WHOLE message, not just the line",
  !/(?<!&lt;)<b>Buy/.test(dailyMessage("Tue 1 Sep", M({ eventTypes: [S("purchase", "<b>Buy</b>")] }))),
);
check(
  "T6 ⭐ past MAX_EVENT_LINES the tail is announced, not silently dropped",
  eventLines(M({ eventTypes: TEN_TYPES })).includes("+4 more event types"),
);
check(
  "T7 ⭐ the money lines are NEVER dropped, however many event types there are",
  (() => {
    const msg = dailyMessage("Tue 1 Sep", M({ eventTypes: TEN_TYPES }));
    return MONEY_LINES.every((s) => msg.includes(s));
  })(),
);
check(
  "T7b ⭐⭐ the money lines survive a registry that BLOWS THE CAP — truncation takes event lines first",
  (() => {
    const msg = dailyMessage("Tue 1 Sep", M({ eventTypes: MANY_LONG }));
    return msg.length <= MAX_MESSAGE_CHARS && MONEY_LINES.every((s) => msg.includes(s));
  })(),
);
check(
  "T7c ⭐ …and so do the header and the Sales line the split is explaining",
  (() => {
    const msg = dailyMessage("Tue 1 Sep", M({ eventTypes: MANY_LONG }));
    return msg.startsWith("📊 <b>CamMan — Tue 1 Sep</b> (final, ET)\nSales: 12\n");
  })(),
);
check(
  "T8 ⭐ a registry whose SIX printed lines alone exceed the cap is truncated to fit",
  dailyMessage("Tue 1 Sep", M({ eventTypes: MANY_LONG })).length <= MAX_MESSAGE_CHARS,
);
check(
  "T8b ⭐ …and it SAYS how many types it dropped, and the count proves the CAP dropped some (not just MAX_EVENT_LINES)",
  (() => {
    const msg = dailyMessage("Tue 1 Sep", M({ eventTypes: MANY_LONG }));
    const m = /^\+(\d+) more event types$/m.exec(msg);
    // MAX_EVENT_LINES alone accounts for 200-6=194. Anything above that is the
    // length budget dropping a line the readability cap would have kept.
    return m !== null && Number(m[1]) > MANY_LONG.length - MAX_EVENT_LINES;
  })(),
  `marker: ${/^\+\d+ more event types$/m.exec(dailyMessage("Tue 1 Sep", M({ eventTypes: MANY_LONG })))?.[0] ?? "(none)"}`,
);
check(
  "T8c ⭐ the fixture really does exceed the cap before any trimming — otherwise T8 is testing nothing",
  eventLines(M({ eventTypes: MANY_LONG })).join("\n").length > MAX_MESSAGE_CHARS,
  String(eventLines(M({ eventTypes: MANY_LONG })).join("\n").length),
);
check(
  "T8d ⭐ an `&`-dense over-cap registry: every printed line is whole, none ends in a half entity",
  (() => {
    const msg = dailyMessage("Tue 1 Sep", M({ eventTypes: AMP_LONG }));
    const lines = msg.split("\n");
    return (
      msg.length <= MAX_MESSAGE_CHARS &&
      !lines.some((l) => DANGLING_ENTITY.test(l)) &&
      // Every kept event line ends with its full rendering, not a slice of one.
      lines.filter((l) => l.startsWith("A &amp; B")).every((l) => /: 0$/.test(l)) &&
      MONEY_LINES.every((s) => msg.includes(s))
    );
  })(),
);

// ── capped(): the last line of defence, executed directly ───────────────────
// assemble() fits the message by dropping whole lines, so capped() does not fire
// from either message builder with a bounded dayLabel. It is still the invariant's
// floor, so it is tested against the input that would break a blind slice.
const AMP_LINE = "A &amp; B ".repeat(40); // 400 chars, entity-dense, no newline
const AMP_DOC = Array.from({ length: 20 }, () => AMP_LINE).join("\n");
check(
  "T8e ⭐ capped() cuts on a LINE BOUNDARY: the body ends with a whole line, never mid-entity",
  (() => {
    const out = capped(AMP_DOC);
    const body = out.slice(0, out.length - "\n… (truncated)".length);
    return (
      out.length <= MAX_MESSAGE_CHARS &&
      out.endsWith("\n… (truncated)") &&
      body.endsWith(AMP_LINE) &&
      !DANGLING_ENTITY.test(body)
    );
  })(),
);
// ⭐ SWEPT, NOT SAMPLED AT ONE INDEX. The first draft of this bar asserted a
// blind slice at exactly MAX_MESSAGE_CHARS-20 and went RED, because that one
// index happens to land on a space — which would have read as "a blind slice is
// safe here" and quietly made T8e a bar over a harmless input. 40 of the 101
// candidate cut points below land inside an `&amp;`; asserting over the range is
// what makes the hazard a property of the fixture rather than of one integer.
const CUTS = Array.from({ length: 101 }, (_, i) => MAX_MESSAGE_CHARS - 100 + i);
const blindUnsafe = CUTS.filter((i) => DANGLING_ENTITY.test(AMP_DOC.slice(0, i)));
check(
  "T8f ⭐ …and a BLIND slice of the same text lands inside an entity at many cut points — so T8e is not testing a safe input",
  blindUnsafe.length > 0,
  `${blindUnsafe.length}/${CUTS.length} blind cut points end mid-entity, e.g. ${JSON.stringify(
    AMP_DOC.slice(0, blindUnsafe[0] ?? 0).slice(-6),
  )}`,
);
check(
  "T8f2 ⭐ capped() is safe at EVERY cut position: 40 shifted copies, none ending in a half entity, none over the cap",
  (() => {
    for (let pad = 0; pad < 40; pad++) {
      const out = capped(`${"x".repeat(pad)}\n${AMP_DOC}`);
      const body = out.replace(/\n… \(truncated\)$/, "");
      if (out.length > MAX_MESSAGE_CHARS || DANGLING_ENTITY.test(body)) return false;
    }
    return true;
  })(),
);
check(
  "T8g ⭐ one enormous line with no break in range is REPLACED, not sliced",
  (() => {
    const out = capped("A &amp; B ".repeat(1000));
    return out.startsWith("⚠️ CamMan report suppressed:") && out.length <= MAX_MESSAGE_CHARS;
  })(),
);
check(
  "T8h capped() is the identity under the cap",
  capped("Revenue: $1.00\nSpend: $2.00") === "Revenue: $1.00\nSpend: $2.00",
);

// ── the residual ────────────────────────────────────────────────────────────
check(
  "T9 ⭐ the manual tally is stated, so `Sales` and the event lines cannot silently disagree",
  eventLines(M({ manualTopup: 4 })).includes("Manual tally: +4 (not in the lines above)"),
);
check(
  "T10 ⭐ unmapped conversions get their own line, and it says what is TRUE of them",
  eventLines(M({ unmapped: 7 })).includes(
    "⚠ 7 unmapped — in no line above, but Sales/Revenue may already count them",
  ),
  JSON.stringify(eventLines(M({ unmapped: 7 }))),
);
check(
  // ⭐ THE CLAIM THAT USED TO BE HERE WAS FALSE, and a bar asserting the new
  // wording would go green again the day someone "tidied" it back. This one
  // fails on the PROPERTY: the line may not tell the reader the strays are
  // counted nowhere, because bar T20 of test-telegram-report-metrics.ts
  // measures the opposite (sales=3 with Σ purchases=2 and 1 stray — the stray
  // is INSIDE the Sales line of this very message), and it may not stay silent
  // about where they went either.
  "T10b ⭐⭐ the unmapped line does NOT claim they are counted nowhere, and DOES name where they already are",
  (() => {
    const line = eventLines(M({ unmapped: 7 })).find((l) => l.includes("unmapped")) ?? "";
    return (
      line !== "" &&
      !/counted nowhere|counts? as nothing|not a sale/i.test(line) &&
      /sales/i.test(line) &&
      /revenue/i.test(line)
    );
  })(),
  eventLines(M({ unmapped: 7 })).find((l) => l.includes("unmapped")) ?? "(no line)",
);
check(
  "T11 no manual top-up and no unmapped rows ⇒ no extra lines",
  eventLines(M({})).length === 2,
);
check(
  "T15 ⭐⭐ THE RESIDUAL IS NOT DROPPABLE: with the cap blown and every event line gone, both residual lines remain",
  (() => {
    const msg = dailyMessage("Tue 1 Sep", M({ eventTypes: MANY_LONG, unmapped: 7, manualTopup: 4 }));
    return (
      msg.length <= MAX_MESSAGE_CHARS &&
      msg.includes("\nManual tally: +4 (not in the lines above)\n") &&
      msg.includes("\n⚠ 7 unmapped — in no line above, but Sales/Revenue may already count them\n")
    );
  })(),
);
check(
  "T16 ⭐ the hourly report's Yesterday-spend line survives the same registry",
  (() => {
    const msg = hourlyMessage("Tue 1 Sep", M({ eventTypes: MANY_LONG }), 392.26);
    return (
      msg.length <= MAX_MESSAGE_CHARS &&
      msg.endsWith("Yesterday spend: $392.26") &&
      MONEY_LINES.every((s) => msg.includes(s))
    );
  })(),
);
check(
  "T17 ⭐ an extra tail line (the cron's carrier-triage summary) is INSIDE the cap, not appended past it",
  (() => {
    const msg = dailyMessage("Tue 1 Sep", M({ eventTypes: MANY_LONG }), [
      "Carrier triage: 3 auto-mapped · 1 need review · 2 pending",
    ]);
    return (
      msg.length <= MAX_MESSAGE_CHARS &&
      msg.endsWith("Carrier triage: 3 auto-mapped · 1 need review · 2 pending")
    );
  })(),
);
check(
  "T12 an EMPTY registry leaves the report exactly as it was before Phase 5",
  dailyMessage("Tue 1 Sep", M({ eventTypes: [], events: {} })).split("\n").length === 7,
);

// ── T22: the escape rule, held STRUCTURALLY rather than per-call-site ───────
//
// T4/T5 prove that TODAY'S interpolation escapes. They say nothing about a line
// added tomorrow: `${t.label}` written straight into a new template is exactly
// the change that takes the report down permanently, and it would leave every
// bar above green. So the formatter is scanned for any reference to `.label`
// outside the ONE helper that escapes it.
//
// ⭐ ONE NEEDLE, ON PURPOSE. A multi-needle source scan passes if ANY needle
// still matches, so a rotted needle in such a bar is invisible — the systemic
// finding from Task 5. With a single needle there is nothing to rot silently,
// and T22b/T22c prove that needle fires, in BOTH line endings.
const FORMATTER = "lib/reporting/telegram-report-format.ts";
const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const LABEL_USE = /\.label\b/g;
const formatterCode = stripComments(readFileSync(FORMATTER, "utf8"));
const labelUses = formatterCode.match(LABEL_USE) ?? [];
check(
  `T22 ⭐⭐ every use of a registry label in ${FORMATTER} goes through eventLabel(), which escapes — a new unescaped \${t.label} is what makes the outage permanent`,
  // Exactly one use, AND that use is the escaped one: together those say the
  // only path from a registry label into the message runs through escapeHtml.
  labelUses.length === 1 && formatterCode.includes("escapeHtml(pluralizeLabel(t.label.replace"),
  `${labelUses.length} use(s) of .label found; escaped-use present: ${formatterCode.includes(
    "escapeHtml(pluralizeLabel(t.label.replace",
  )}`,
);
check(
  "T22b ⭐ …and the scanner really fires (positive control on the needle)",
  (stripComments("const line = `${t.label}: ${n}`;").match(LABEL_USE) ?? []).length === 1,
);
check(
  "T22c ⭐ …in BOTH line endings, and comments are stripped in both",
  (() => {
    const lf = "// t.label in prose\nconst line = `${t.label}`;\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    const nLf = (stripComments(lf).match(LABEL_USE) ?? []).length;
    const nCrlf = (stripComments(crlf).match(LABEL_USE) ?? []).length;
    return nLf === 1 && nCrlf === 1;
  })(),
);

// ── T25: extraLines were the one way INTO the message that skipped escaping ─
//
// T22 holds the rule structurally for registry labels; `extraLines` bypassed it
// entirely, because it is text the CALLER assembles and this function used to
// splice it in verbatim. Today's only caller passes three integers — which is
// exactly the reasoning that leaves a hole open until the day a caller
// interpolates something with a "<" in it and the report 400s every hour for
// ever. Now escaped at the door; these bars are what keep it that way.
check(
  "T25 ⭐⭐ an extra tail line carrying markup renders as TEXT — the one door into the message that skipped escapeHtml",
  (() => {
    const msg = dailyMessage("Tue 1 Sep", M({}), ["Carrier <b>triage</b>: 3 & 1 > 0"]);
    return (
      msg.endsWith("Carrier &lt;b&gt;triage&lt;/b&gt;: 3 &amp; 1 &gt; 0") &&
      // …and the ONLY angle-bracket markup left in the payload is the header's
      // own bold pair, which is the exact condition Telegram 400s on.
      (msg.match(/<[^>]*>/g) ?? []).join("") === "<b></b>"
    );
  })(),
  dailyMessage("Tue 1 Sep", M({}), ["Carrier <b>triage</b>: 3 & 1 > 0"]).split("\n").pop(),
);
check(
  "T25b ⭐ …and the escaped line is still INSIDE the cap, counted post-escape, with the money lines intact",
  (() => {
    const msg = dailyMessage("Tue 1 Sep", M({ eventTypes: MANY_LONG }), [
      `Carrier triage: ${"&".repeat(200)}`,
    ]);
    return (
      msg.length <= MAX_MESSAGE_CHARS &&
      msg.endsWith(`Carrier triage: ${"&amp;".repeat(200)}`) &&
      MONEY_LINES.every((s) => msg.includes(s))
    );
  })(),
);

// ── T26: the tables print plural, and so does this ──────────────────────────
//
// The count columns on /reports and the tiles on the campaign page head
// themselves with pluralizeLabel(); this report printed the RAW label, so one
// screen read "Registrations" and the phone read "Registration" for the same
// number. Both sides are checked: that the line agrees with the shared
// generator, AND that the generator's answer is the literal expected word — a
// comparison against one source alone would pass if both went singular.
check(
  "T26 ⭐ the event line is headed with the SAME pluralisation the report tables use",
  (() => {
    const line = eventLines(M({ eventTypes: [S("registration", "Registration")] }))[0];
    return line === `${pluralizeLabel("Registration")}: 0` && line === "Registrations: 0";
  })(),
  eventLines(M({ eventTypes: [S("registration", "Registration")] }))[0],
);
check(
  "T26b ⭐ …and an already-plural label is not pluralised twice (the shared rule, not a suffix)",
  eventLines(M({ eventTypes: [S("purchase", "Purchases")] }))[0] === "Purchases: 0",
  eventLines(M({ eventTypes: [S("purchase", "Purchases")] }))[0],
);

// ── the rendered article, for a human to read ───────────────────────────────
const SPLIT = M({
  eventTypes: [S("registration", "Registrations"), S("purchase", "Purchases")],
  events: {
    registration: { n: 214, revenue: 0, pending_revenue: 0 },
    purchase: { n: 11, revenue: 880, pending_revenue: 120 },
  },
  unmapped: 3,
  manualTopup: 1,
});

console.log("\n--- rendered daily ---\n" + daily);
console.log("\n--- rendered hourly ---\n" + hourly);
console.log("\n--- rendered daily, WITH the split ---\n" + dailyMessage("Wed 1 Jul", SPLIT));
console.log(
  "\n--- rendered hourly, WITH the split ---\n" + hourlyMessage("Thu 2 Jul", SPLIT, 392.26),
);
console.log(
  "\n--- hostile label: <b>Buy</b> & <win> 💰 ---\n" +
    dailyMessage("Wed 1 Jul", M({ eventTypes: [S("purchase", "<b>Buy</b> & <win> 💰")] })),
);
const overCap = dailyMessage("Wed 1 Jul", M({ eventTypes: MANY_LONG, unmapped: 3, manualTopup: 1 }));
console.log(
  `\n--- over-cap (200 types × 600-char labels): ${overCap.length} chars, cap ${MAX_MESSAGE_CHARS} ---\n` +
    overCap.slice(0, 400) +
    "\n…[first event line truncated in THIS console dump only]…\n" +
    overCap.slice(-300),
);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
