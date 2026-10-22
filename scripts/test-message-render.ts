// scripts/test-message-render.ts — pure suite for lib/messages (no DB).
// npx tsx scripts/test-message-render.ts
import { TAGS, expandWorstCase, findTags, findUnknownTokens, type RecipientData } from "@/lib/messages/tags";
import { SEED_FORMATS, T1_TEMPLATE, validateCustomText, validateTemplate } from "@/lib/messages/format";
import {
  checkRecipientBody, firstNameMaxLength, renderMessage, renderWorstCase, requiredContactTags, requiredTags, type MessageShape,
} from "@/lib/messages/render";
import { buildStageSms } from "@/lib/sends/stage-sms";
import { tagSkipShare } from "@/lib/messages/skip-share";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};
const eq = (n: string, got: unknown, want: unknown) =>
  bar(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log("R1 — tag registry + normalizers");
const fn = TAGS.first_name.normalize;
eq("R1.1 ' JOSÉ ' → Jose", fn(" JOSÉ "), "Jose");
eq("R1.2 mary-jane → Mary-Jane", fn("mary-jane"), "Mary-Jane");
eq("R1.3 o'neil → O'Neil", fn("o'neil"), "O'Neil");
eq("R1.4 Ægir → Aegir", fn("Ægir"), "Aegir");
eq("R1.5 Zoë → Zoe", fn("Zoë"), "Zoe");
eq("R1.6 李雷 → null", fn("李雷"), null);
eq("R1.7 N/A → null", fn("N/A"), null);
eq("R1.8 '-' → null", fn("-"), null);
eq("R1.9 Jo3 → null", fn("Jo3"), null);
eq("R1.10 J → null", fn("J"), null);
eq("R1.11 16 chars → null", fn("Maximilianuslong"), null);
eq("R1.12 15 chars kept", fn("Maximilianuslon"), "Maximilianuslon");
eq("R1.13 '' → null", fn(""), null);
eq("R1.14 null → null", fn(null), null);
eq("R1.15 Unknown/none junk", [fn("Unknown"), fn(" NONE ")], [null, null]);

const zip = TAGS.zip.normalize;
eq("R1.16 02134", zip("02134"), "02134");
eq("R1.17 ZIP+4 dashed", zip("02134-1234"), "02134");
eq("R1.18 ZIP+4 plain", zip("021341234"), "02134");
eq("R1.19 4 digits → null", zip("2134"), null);

const st = TAGS.state.normalize;
eq("R1.20 tx → TX", st("tx"), "TX");
eq("R1.21 Texas → TX", st("Texas"), "TX");
eq("R1.22 'new  york' → NY", st("new  york"), "NY");
eq("R1.23 ZZ → null", st("ZZ"), null);
eq("R1.24 Unknown → null", st("Unknown"), null);
eq("R1.25 DC", st("District of Columbia"), "DC");

eq("R1.26 findTags distinct, first-seen", findTags("Hi {first_name}, {FirstName} {zip} {first_name}"), ["first_name", "zip"]);
eq("R1.27 findUnknownTokens", findUnknownTokens("Hi {first_name}, {FirstName} {zip} {url}"), ["{FirstName}"]);
eq("R1.28 spaced token is not a tag", findTags("{ first_name }"), []);
// Review fix: never send a MANGLED name — transliterate, or call it missing.
eq("R1.30 Đorđe → Dorde", fn("Đorđe"), "Dorde");
eq("R1.31 Ștefan → Stefan (Latin Ext-B)", fn("Ștefan"), "Stefan");
eq("R1.32 Nguyễn → Nguyen (Latin Ext Additional)", fn("Nguyễn"), "Nguyen");
eq("R1.33 Yıldız → Yildiz", fn("Yıldız"), "Yildiz");
eq("R1.34 Þór → Thor", fn("Þór"), "Thor");
eq("R1.35 Ħanna → Hanna", fn("Ħanna"), "Hanna");
eq("R1.36 curly apostrophe O’Neil → O'Neil", fn("O’Neil"), "O'Neil");
eq("R1.37 non-breaking hyphen Jean‑Luc → Jean-Luc", fn("Jean‑Luc"), "Jean-Luc");
eq("R1.38 punctuation-only names are missing", [fn("--"), fn("''"), fn("- -"), fn("A-")], [null, null, null, null]);
eq("R1.39 any unmappable letter ⇒ missing, never a truncated name", [fn("Ελένη"), fn("Ana李")], [null, null]);
eq("R1.29 worst cases per spec A1", [TAGS.first_name.worstCase.length, TAGS.zip.worstCase, TAGS.state.worstCase, TAGS.brand.worstCase.length], [15, "00000", "XX", 20]);

// ── R2 — grammar + renderer; buildStageSms = T1 ─────────────────────────────
// FROZEN copy of origin/main cdf96d7f lib/sends/stage-sms.ts buildStageSms.
// The reference T1 must equal byte-for-byte. Never edit it to make a test pass.
function legacyBuildStageSms(opts: {
  brandName: string;
  creativeText: string | null | undefined;
  linkUrl?: string | null;
  stopText: string;
}): string {
  const { brandName, creativeText, stopText } = opts;
  if (!creativeText) return "";
  const link = (opts.linkUrl ?? "").trim();
  const base = `${brandName}: ${creativeText}`;
  const footer = (stopText ?? "").trim();
  const parts = [base];
  if (link.length > 0) parts.push(link);
  if (footer.length > 0) parts.push(footer);
  return parts.join("\n");
}

console.log("\nR2 — grammar + renderer");
const NO_ONE: RecipientData = { first_name: null, zip: null, state: null };
const t1: MessageShape = { kind: "template", formatId: null, template: T1_TEMPLATE };
const tpl = (name: string): MessageShape => ({
  kind: "template", formatId: null, template: SEED_FORMATS.find((f) => f.name.startsWith(name))!.template,
});

let gridDiffs = 0, renderDiffs = 0, cases = 0;
for (const brand of ["Guide Kin", ""])
  for (const creative of ["Hi there", "Line1\nLine2", " lead/trail ", "", null])
    for (const link of ["https://gdkn.org/r/Ab3dE9x", "", "  ", " https://x.co/a ", null])
      for (const stop of ["Stop to END", "", "  Reply STOP  "]) {
        cases++;
        const legacy = legacyBuildStageSms({ brandName: brand, creativeText: creative, linkUrl: link, stopText: stop });
        if (buildStageSms({ brandName: brand, creativeText: creative, linkUrl: link, stopText: stop }) !== legacy) gridDiffs++;
        const r = renderMessage({ shape: t1, brandName: brand, creativeText: creative, linkUrl: link, stopText: stop, recipient: NO_ONE });
        if (!r.ok || r.body !== legacy) renderDiffs++;
      }
bar("R2.1 buildStageSms == legacy over the grid", gridDiffs === 0 && cases === 150, `${gridDiffs} diffs / ${cases}`);
bar("R2.2 renderMessage(T1) == legacy over the grid", renderDiffs === 0, `${renderDiffs} diffs / ${cases}`);

const base = { brandName: "G", creativeText: "Hi", linkUrl: "", stopText: "Stop to END", recipient: NO_ONE };
// Owner 2026-10-19: trailing blank rows are TRIMMED after rendering, every format + custom.
eq("R2.3 T2 no-link ends with the stop text, no trailing \\n", renderMessage({ ...base, shape: tpl("T2") }), { ok: true, body: "Hi G Stop to END" });
eq("R2.3b custom text: trailing blank rows trimmed, inner blank rows kept",
  renderMessage({ ...base, shape: { kind: "custom", text: "{creative_text}<new_row><new_row>{stop_text}<new_row>{url}<new_row><new_row>" } }),
  { ok: true, body: "Hi\n\nStop to END" });
eq("R2.3c whitespace-only trailing rows trimmed", renderMessage({ ...base, shape: { kind: "custom", text: "{creative_text} {url}<new_row>{stop_text}<new_row>  " } }), { ok: true, body: "Hi \nStop to END" });
eq("R2.4 T2 with link", renderMessage({ ...base, linkUrl: "https://x.co/a", shape: tpl("T2") }), { ok: true, body: "Hi G Stop to END\n\nhttps://x.co/a" });
eq("R2.5 T3 has no brand", renderMessage({ ...base, linkUrl: "https://x.co/a", shape: tpl("T3") }), { ok: true, body: "Hi\nhttps://x.co/a\nStop to END" });
eq("R2.6 T1 seed is T1_TEMPLATE and the only default", SEED_FORMATS.filter((f) => f.isDefault).map((f) => f.template), [T1_TEMPLATE]);

eq("R2.7 {FirstName} stays literal", renderMessage({ ...base, shape: t1, creativeText: "Hi {FirstName}" }), { ok: true, body: "G: Hi {FirstName}\nStop to END" });
eq("R2.8 {first_name} missing", renderMessage({ ...base, shape: t1, creativeText: "Hi {first_name}" }), { ok: false, reason: "missing_tag", tag: "first_name" });
eq("R2.9 {first_name} normalized", renderMessage({ ...base, shape: t1, creativeText: "Hi {first_name}", recipient: { ...NO_ONE, first_name: "josé" } }), { ok: true, body: "G: Hi Jose\nStop to END" });
eq("R2.10 {zip} {state} {brand} in creative", renderMessage({ ...base, shape: tpl("T3"), creativeText: "{brand} in {state} {zip}", recipient: { first_name: null, zip: "02134-1234", state: "texas" } }), { ok: true, body: "G in TX 02134\nStop to END" });
eq("R2.11 empty brand + {brand} tag ⇒ missing", renderMessage({ ...base, brandName: " ", shape: tpl("T3"), creativeText: "{brand} hi" }), { ok: false, reason: "missing_tag", tag: "brand" });
eq("R2.12 no re-scan: creative '{url}' stays literal", renderMessage({ ...base, linkUrl: "https://x.co/a", shape: t1, creativeText: "go {url}" }), { ok: true, body: "G: go {url}\nhttps://x.co/a\nStop to END" });
eq("R2.13 empty creative ⇒ empty body", renderMessage({ ...base, shape: tpl("T2"), creativeText: "" }), { ok: true, body: "" });
eq("R2.14 custom text with tags + blocks",
  renderMessage({ ...base, linkUrl: "https://x.co/a", shape: { kind: "custom", text: "Hey {first_name}!<new_row>{creative_text}<new_row>{url}<new_row>{stop_text}" }, recipient: { ...NO_ONE, first_name: "ANA" } }),
  { ok: true, body: "Hey Ana!\nHi\nhttps://x.co/a\nStop to END" });

eq("R2.29 custom text: a {brand} value is never re-scanned as template syntax",
  renderMessage({ ...base, brandName: "Acme {url}<new_row>{stop_text}", linkUrl: "https://x.co/a", shape: { kind: "custom", text: "From {brand}<new_row>{creative_text}<new_row>{url}<new_row>{stop_text}" } }),
  { ok: true, body: "From Acme {url}<new_row>{stop_text}\nHi\nhttps://x.co/a\nStop to END" });
eq("R2.30 custom text: a {first_name} value is never re-scanned",
  renderMessage({ ...base, linkUrl: "https://x.co/a", shape: { kind: "custom", text: "{first_name}{zip}<new_row>{creative_text}<new_row>{url}<new_row>{stop_text}" }, recipient: { first_name: "Ann", zip: "02134", state: null } }),
  { ok: true, body: "Ann02134\nHi\nhttps://x.co/a\nStop to END" });

// firstNameMaxLength: "B: " + creative; no link, no footer ⇒ body = 3 + creative length.
const pad = (n: number) => "a".repeat(n);
const fixedNoName = (creative: string) => ({ shape: t1, brandName: "B", creativeText: creative, linkUrl: "", stopText: "" });
eq("R2.15 firstNameMaxLength = 10 when the no-name body is 150", firstNameMaxLength(fixedNoName("Hi {first_name}" + pad(144)), 1), 10);
eq("R2.16 firstNameMaxLength = 15 when everything fits", firstNameMaxLength(fixedNoName("Hi {first_name}"), 1), 15);
eq("R2.17 firstNameMaxLength = null when even L=0 overflows", firstNameMaxLength(fixedNoName("Hi {first_name}" + pad(155)), 1), null);
eq("R2.18 renderWorstCase", renderWorstCase(fixedNoName("Hi {first_name} in {state}")), "B: Hi XXXXXXXXXXXXXXX in XX");
eq("R2.19 checkRecipientBody", [checkRecipientBody(pad(160), 1), checkRecipientBody(pad(161), 1), checkRecipientBody(pad(161), 4)], [{ ok: true }, { ok: false, reason: "segment_limit" }, { ok: true }]);
eq("R2.20 requiredTags creative + custom", requiredTags({ shape: { kind: "custom", text: "{zip} {creative_text}{url}{stop_text}" }, creativeText: "Hi {first_name} {FirstName}" }), ["first_name", "zip"]);
eq("R2.21 requiredTags ignores template blocks", requiredTags({ shape: t1, creativeText: "Hi" }), []);
eq("R2.21b requiredContactTags: {brand} needs no contact data", requiredContactTags({ shape: t1, creativeText: "{brand} hi {first_name} {zip}" }), ["first_name", "zip"]);

eq("R2.22 validateTemplate missing_block", validateTemplate("{creative_text}{url}")?.code, "missing_block");
eq("R2.23 validateTemplate unknown_token", validateTemplate("{first_name} {creative_text}{url}{stop_text}")?.code, "unknown_token");
eq("R2.24 seeds all validate", SEED_FORMATS.map((f) => validateTemplate(f.template)), [null, null, null]);
eq("R2.25 custom missing everything", validateCustomText("Hi {first_name}")?.code, "custom_text_missing_required_block");
eq("R2.26 custom without {creative_text}", validateCustomText("Hi {first_name} {url} {stop_text}")?.code, "custom_text_missing_required_block");
eq("R2.27 custom with all three", validateCustomText("Hi {first_name}<new_row>{creative_text}<new_row>{url}<new_row>{stop_text}"), null);
eq("R2.28 custom unknown token is literal", validateCustomText("{creative_text}{url}{stop_text}{Foo}"), null);

console.log("\nP4 — creative editor worst case (each tag at its worstCase stand-in)");
eq("R4.1 worst case of \"Hi {first_name}\" is 18 characters", expandWorstCase("Hi {first_name}").length, 18);
eq("R4.2 every tag expands to its worstCase", expandWorstCase("{first_name}|{zip}|{state}|{brand}"),
  `${TAGS.first_name.worstCase}|${TAGS.zip.worstCase}|${TAGS.state.worstCase}|${TAGS.brand.worstCase}`);
eq("R4.3 unknown tokens and blocks are untouched", expandWorstCase("{FirstName} {url} {creative_text}"), "{FirstName} {url} {creative_text}");
eq("R4.4 text without tags is unchanged", expandWorstCase("Plain text"), "Plain text");

console.log("\nMinor #1 — trailing rows (owner 2026-10-19: trailing blank rows are trimmed)");
{
  const links = ["https://x.co/r/ABC", "", null];
  const footers = ["Reply STOP to opt out", "", "   "];
  let endsNl = 0;
  const trailingSpace: string[] = [];
  for (const f of SEED_FORMATS) for (const linkUrl of links) for (const stopText of footers) {
    const shape = { kind: "template" as const, formatId: 1, template: f.template };
    const r = renderMessage({ shape, brandName: "Acme", creativeText: "Hi there", linkUrl, stopText, recipient: { first_name: null, zip: null, state: null } });
    if (!r.ok) continue;
    if (r.body.endsWith("\n")) endsNl++;
    if (/ $/.test(r.body)) trailingSpace.push(f.name.split(" ")[0]);
  }
  eq("R5.1 no seeded format × (link present / empty / null) × (footer / empty / blank) ever ends in a newline", endsNl, 0);
  eq("R5.2 the only trailing space: T2 with an empty footer (its literal space before {stop_text})", [...new Set(trailingSpace)], ["T2"]);
}

console.log("\nMinor #11 — skip share with no will_send (the preview timed out)");
eq("R6.1 will_send null ⇒ no share (nothing to show)", tagSkipShare({ willSend: null, missingData: 3, segmentLimit: 0 }), null);
eq("R6.2 will_send 5, skipped 5 ⇒ 50%", tagSkipShare({ willSend: 5, missingData: 4, segmentLimit: 1 }), { skipped: 5, pct: 50 });

console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
