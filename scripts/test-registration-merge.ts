// PURE — no DB, no env. Run: npx tsx scripts/test-registration-merge.ts
//
// Leads count as Registrations in reports (owner ruling 2026-11-04, migration
// 0232). A type flagged counts_as_registration is folded into the retarget
// signal's COUNT columns everywhere a report shows a per-type count, loses its own
// count / rate / pending columns, and keeps its money columns.
//
// ⭐ The registry here uses invented keys (`signup`, `form`, `buy`), so a
// generator that hard-codes `registration` / `lead` cannot pass.
import {
  buildEventColumns,
  countedEventTypes,
  eventCellValue,
  eventColumnById,
  mergedCount,
  registrationMerge,
  resolveEventColumn,
  type EventMap,
  type EventTypeSpec,
} from "@/lib/reporting/event-columns";
import { eventCountColumns, eventCountValue } from "@/components/reports/event-columns-view";
import { eventLines } from "@/lib/reporting/telegram-report-format";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const T = (key: string, label: string, display_order: number, f: Partial<EventTypeSpec> = {}): EventTypeSpec => ({
  key,
  label,
  display_order,
  is_purchase: false,
  counts_revenue: false,
  is_retarget_signal: false,
  counts_as_registration: false,
  archived: false,
  ...f,
});

const SIGNUP = T("signup", "Signup", 20, { is_retarget_signal: true });
const FORM = T("form", "Form", 25, { counts_revenue: true, counts_as_registration: true });
const BUY = T("buy", "Buy", 10, { is_purchase: true, counts_revenue: true });
const REG = [BUY, FORM, SIGNUP];

const tally = (n: number, pending_n = 0, revenue = 0, pending_revenue = 0) => ({ n, pending_n, revenue, pending_revenue });
const EV: EventMap = { signup: tally(3, 1), form: tally(5, 2, 62, 4), buy: tally(2, 0, 100) };
const CLICKERS = 40;

const cols = buildEventColumns(REG);
const ids = cols.map((c) => c.id);
const col = (id: string) => cols.find((c) => c.id === id)!;

console.log("\nM — the merge rule");
check("M1 host = the retarget signal, members = the counts_as_registration types",
  JSON.stringify(registrationMerge(REG)) === JSON.stringify({ host: "signup", members: ["form"] }),
  JSON.stringify(registrationMerge(REG)));
check("M2 no retarget signal in the registry ⇒ merge OFF (nothing to fold into)",
  JSON.stringify(registrationMerge([BUY, FORM])) === JSON.stringify({ host: null, members: [] }));
check("M3 a type that is BOTH a signal and counts_as_registration is not a member of itself",
  registrationMerge([T("x", "X", 1, { is_retarget_signal: true, counts_as_registration: true })]).members.length === 0);
check("M4 countedEventTypes drops the member only",
  countedEventTypes(REG).map((t) => t.key).join(",") === "buy,signup");
check("M5 mergedCount over a count map: host = host + members; others untouched",
  mergedCount({ signup: 3, form: 5, buy: 2 }, "signup", registrationMerge(REG)) === 8 &&
    mergedCount({ signup: 3, form: 5, buy: 2 }, "buy", registrationMerge(REG)) === 2);

console.log("\nC — generated columns");
check("C1 the member has NO count / rate / pending column (owner ruling 2)",
  !ids.includes("evt:form:count") && !ids.includes("evt:form:rate") && !ids.includes("evt:form:pending_n"), ids.join(" "));
check("C2 the member KEEPS its money columns ($, pending $, EPC)",
  ids.includes("evt:form:revenue") && ids.includes("evt:form:pending_revenue") && ids.includes("evt:form:epc"));
check("C3 the host's count header is still the host's own label",
  col("evt:signup:count").header === "Signups");
check("C4 host count = host + member events (3 + 5)", eventCellValue(col("evt:signup:count"), EV, CLICKERS) === 8);
check("C5 host pending = host + member pending (1 + 2)", eventCellValue(col("evt:signup:pending_n"), EV, CLICKERS) === 3);
check("C6 host rate = merged count ÷ counted clickers", eventCellValue(col("evt:signup:rate"), EV, CLICKERS) === 8 / 40);
check("C7 Signup→Buy % uses the MERGED denominator (owner ruling 3): 2 ÷ 8",
  eventCellValue(col("evtfunnel:signup:buy"), EV, CLICKERS) === 2 / 8);
check("C8 member money reads the member's own tally ($62, $4 pending, EPC 62/40)",
  eventCellValue(col("evt:form:revenue"), EV, CLICKERS) === 62 &&
    eventCellValue(col("evt:form:pending_revenue"), EV, CLICKERS) === 4 &&
    eventCellValue(col("evt:form:epc"), EV, CLICKERS) === 62 / 40);
check("C9 purchase columns are unchanged (Sales stays Sales)",
  eventCellValue(col("evt:buy:count"), EV, CLICKERS) === 2 && eventCellValue(col("evt:buy:revenue"), EV, CLICKERS) === 100);
const noHost = buildEventColumns([BUY, FORM]).map((c) => c.id);
check("C10 with no signal type the member keeps its own count columns", noHost.includes("evt:form:count"));
const lone = buildEventColumns([BUY, SIGNUP]);
check("C11 with no member the host column carries no mergeKeys (unchanged behaviour)",
  lone.every((c) => c.mergeKeys === undefined));

console.log("\nS — persisted sort ids");
check("S1 ⭐ resolveEventColumn carries the merge, so a server sort on the host sorts by the merged count",
  eventCellValue(resolveEventColumn("evt:signup:count", REG)!, EV, CLICKERS) === 8);
check("S2 eventColumnById alone cannot know the merge (why S1 exists)",
  eventCellValue(eventColumnById("evt:signup:count")!, EV, CLICKERS) === 3);
check("S3 a stale member count id still parses (falls back to the id-only parse)",
  resolveEventColumn("evt:form:count", REG)?.id === "evt:form:count");

console.log("\nV — count-only surfaces (/creatives)");
const rows = [{ events: { signup: 3, form: 5, buy: 2 }, unmapped: 0, manual_topup: 0 }];
const vcols = eventCountColumns(REG, rows, false, (c) => c);
check("V1 no separate member count column", !vcols.some((c) => c.id === "evt:form:count"), vcols.map((c) => c.id).join(" "));
const vHost = vcols.find((c) => c.id === "evt:signup:count");
check("V2 the host count column = 3 + 5", vHost !== undefined && eventCountValue(vHost, rows[0]) === 8);

console.log("\nT — Telegram hourly lines");
const lines = eventLines({
  events: { signup: { n: 3, revenue: 0, pending_revenue: 0 }, form: { n: 5, revenue: 62, pending_revenue: 0 }, buy: { n: 2, revenue: 100, pending_revenue: 0 } },
  eventTypes: [
    { key: "signup", label: "Signup", countKeys: ["signup", "form"] },
    { key: "form", label: "Form", moneyOnly: true },
    { key: "buy", label: "Buy", countKeys: ["buy"] },
  ],
  unmapped: 0,
  manualTopup: 0,
} as unknown as Parameters<typeof eventLines>[0]);
check("T1 the host line counts the member (Signups: 8)", lines.some((l) => l.startsWith("Signups: 8")), lines.join(" | "));
check("T2 the member prints money only (Forms $: $62.00)", lines.some((l) => l === "Forms $: $62.00"), lines.join(" | "));
check("T3 no member COUNT line", !lines.some((l) => l.startsWith("Forms:")));
const quiet = eventLines({
  events: { signup: { n: 3, revenue: 0, pending_revenue: 0 } },
  eventTypes: [{ key: "signup", label: "Signup", countKeys: ["signup", "form"] }, { key: "form", label: "Form", moneyOnly: true }],
  unmapped: 0,
  manualTopup: 0,
} as unknown as Parameters<typeof eventLines>[0]);
check("T4 a member with no money prints nothing", !quiet.some((l) => l.startsWith("Form")), quiet.join(" | "));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
