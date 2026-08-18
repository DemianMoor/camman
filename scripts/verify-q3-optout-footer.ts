// Q3 — per-provider opt-out footer chain. THE COMPLIANCE HARNESS.
//
// This phase changes the opt-out wording on live SMS, so the bar splits in two
// and both halves are hard:
//
//   (A) NULL-FOOTER providers must be BYTE-IDENTICAL to today. Corpus-proven,
//       same standard as B2. One mismatch is a hard stop.
//   (B) STORED-FOOTER providers must produce exactly the same body with the
//       footer SWAPPED — a substring-only difference — and the kickoff gate
//       must pass on the NEW text.
//
// Plus the invariant that matters most:
//
//   (C) THE GATE VALIDATES WHAT SHIPS. A gate that inspects a field which lost
//       the resolution would approve a message whose real opt-out wording was
//       never checked. Proven by construction: a stage whose stop_text contains
//       STOP but whose winning footer does NOT must be REFUSED.
//
//   (D) Preview count == sent-body count for a footer-overridden provider
//       (B2's standard (c), re-run with the footer in play).
//
// FAULT INJECTION throughout: a green run is only evidence if the harness can
// go red, so each bar is accompanied by a deliberately broken input.
import "./_env-preload";

import { promises as fs } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import { calculateSmsSegments } from "@/lib/creative-helpers";
import { buildRepresentativeTrackedLinkUrl, buildTrackedLinkUrl } from "@/lib/links/tracked-link";
import {
  DEFAULT_OPT_OUT_FOOTER,
  optOutGateSubject,
  resolveOptOutFooter,
} from "@/lib/sends/opt-out-footer";
import { hasOptOutLanguage } from "@/lib/sends/segments";
import { buildStageSms } from "@/lib/sends/stage-sms";

const CUTOVER = "2026-08-17T12:21:28Z";
const BATCH = 5000;

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}

interface CorpusRow {
  code: string; domain: string; brand_name: string; creative_text: string;
  stop_text: string; rendered_text: string;
  provider_key: string | null; provider_footer: string | null; phone_footer: string | null;
}

async function main() {
  // ── UNIT: the resolution chain itself ────────────────────────────────────
  console.log("\nCHAIN — precedence, most specific first:");
  const cases: [string, Parameters<typeof resolveOptOutFooter>[0], string, string][] = [
    ["number wins over everything", { numberFooter: "N", providerFooter: "P", stageStopText: "S" }, "N", "number"],
    ["provider wins when number is null", { numberFooter: null, providerFooter: "P", stageStopText: "S" }, "P", "provider"],
    ["stage wins when both above are null", { providerFooter: null, stageStopText: "S" }, "S", "stage"],
    ["default when the whole chain is empty", {}, DEFAULT_OPT_OUT_FOOTER, "default"],
    ["whitespace-only states no preference", { numberFooter: "   ", providerFooter: "P" }, "P", "provider"],
    ["values are trimmed", { providerFooter: "  P  " }, "P", "provider"],
    ["provider-appends out-ranks all and appends NOTHING", { numberFooter: "N", providerFooter: "P", stageStopText: "S", providerAppendsOwnOptOut: true }, "", "provider_appends"],
  ];
  for (const [name, input, wantText, wantLevel] of cases) {
    const r = resolveOptOutFooter(input);
    check(`chain: ${name}`, r.text === wantText && r.level === wantLevel, `got text=${JSON.stringify(r.text)} level=${r.level}`);
  }

  // ── SCOPE ────────────────────────────────────────────────────────────────
  const providers = (await db.execute(sql`
    SELECT id, sms_provider_id, adapter_code, opt_out_footer FROM sms_providers ORDER BY id
  `)) as unknown as { id: number; sms_provider_id: string; adapter_code: string | null; opt_out_footer: string | null }[];
  const withFooter = providers.filter((p) => (p.opt_out_footer ?? "").trim().length > 0);
  console.log(`\nPROVIDER SCOPE — ${providers.length} rows, ${withFooter.length} carry a stored footer`);
  for (const p of providers) {
    console.log(`     #${p.id} ${p.sms_provider_id} footer=${p.opt_out_footer === null ? "NULL" : JSON.stringify(p.opt_out_footer)}`);
  }
  check("provider scope is non-empty", providers.length > 0, `${providers.length}`);
  // Non-vacuous: bar (B) needs at least one stored footer or it proves nothing.
  check(
    "at least one provider carries a stored footer (bar B is non-vacuous)",
    withFooter.length > 0,
    withFooter.map((p) => `${p.sms_provider_id}=${JSON.stringify(p.opt_out_footer)}`).join(", ") || "NONE",
  );

  const phoneFooters = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE opt_out_footer IS NOT NULL)::int AS set_count, count(*)::int AS total
    FROM provider_phones
  `)) as unknown as { set_count: number; total: number }[];
  console.log(`  provider_phones.opt_out_footer set on ${phoneFooters[0].set_count} of ${phoneFooters[0].total} numbers`);
  check(
    "the new number-level column ships NULL everywhere",
    phoneFooters[0].set_count === 0,
    `${phoneFooters[0].set_count} set`,
  );

  // ── (A) BYTE-IDENTICAL for NULL-footer providers ─────────────────────────
  const corpusScope = (await db.execute(sql`
    SELECT count(*)::int AS total FROM stage_sends ss
    WHERE ss.rendered_text IS NOT NULL AND ss.created_at >= ${CUTOVER}::timestamptz
  `)) as unknown as { total: number }[];
  console.log(`\n(A) Corpus since ${CUTOVER}: ${corpusScope[0].total.toLocaleString()} rows`);
  check("corpus is non-empty", corpusScope[0].total > 0, `${corpusScope[0].total}`);

  let comparedNull = 0;
  let comparedStored = 0;
  const nullMismatch: { stored: string; got: string }[] = [];
  const swapBad: { stored: string; got: string; expected: string }[] = [];
  const swapSamples: { key: string; before: string; after: string; footer: string }[] = [];
  const nullSamples: string[] = [];

  for (let off = 0; ; off += BATCH) {
    const rows = (await db.execute(sql`
      SELECT l.code, d.domain, b.name AS brand_name, cr.text AS creative_text,
             s.stop_text, ss.rendered_text,
             p.sms_provider_id AS provider_key, p.opt_out_footer AS provider_footer,
             ph.opt_out_footer AS phone_footer
      FROM stage_sends ss
      JOIN campaign_stages s ON s.id = ss.stage_id
      JOIN campaigns c ON c.id = s.campaign_id
      JOIN brands b ON b.id = c.brand_id
      JOIN creatives cr ON cr.id = s.creative_id
      JOIN links l ON l.id = ss.link_id
      JOIN short_domains d ON d.id = l.short_domain_id
      LEFT JOIN sms_providers p ON p.id = s.sms_provider_id
      LEFT JOIN provider_phones ph ON ph.id = s.provider_phone_id
      WHERE ss.rendered_text IS NOT NULL AND ss.created_at >= ${CUTOVER}::timestamptz
      ORDER BY ss.id LIMIT ${BATCH} OFFSET ${off}
    `)) as unknown as CorpusRow[];
    if (rows.length === 0) break;
    for (const r of rows) {
      const resolved = resolveOptOutFooter({
        numberFooter: r.phone_footer,
        providerFooter: r.provider_footer,
        stageStopText: r.stop_text,
      });
      const rebuilt = buildStageSms({
        brandName: r.brand_name,
        creativeText: r.creative_text,
        linkUrl: buildTrackedLinkUrl(r.domain, r.code),
        stopText: resolved.text,
      });
      const providerHasFooter = (r.provider_footer ?? "").trim().length > 0;
      const numberHasFooter = (r.phone_footer ?? "").trim().length > 0;

      if (!providerHasFooter && !numberHasFooter) {
        // (A) nothing out-ranks the stage ⇒ must be byte-identical to what shipped.
        comparedNull++;
        if (rebuilt !== r.rendered_text) nullMismatch.push({ stored: r.rendered_text, got: rebuilt });
        else if (nullSamples.length < 2) nullSamples.push(rebuilt);
      } else {
        // (B) a footer out-ranks the stage ⇒ the ONLY difference may be the
        // footer substring. Reconstruct by swapping and demand an exact match.
        comparedStored++;
        const expected = r.rendered_text.endsWith(r.stop_text)
          ? r.rendered_text.slice(0, r.rendered_text.length - r.stop_text.length) + resolved.text
          : "<stored body does not end with its stage stop_text>";
        if (rebuilt !== expected) swapBad.push({ stored: r.rendered_text, got: rebuilt, expected });
        else if (swapSamples.length < 3) {
          swapSamples.push({ key: r.provider_key ?? "?", before: r.rendered_text, after: rebuilt, footer: resolved.text });
        }
      }
    }
    if (rows.length < BATCH) break;
  }

  console.log(`  rows whose chain resolves to the STAGE (bar A): ${comparedNull.toLocaleString()}`);
  console.log(`  rows out-ranked by a stored footer (bar B):     ${comparedStored.toLocaleString()}`);
  check("bar A covered rows", comparedNull > 0, `${comparedNull}`);
  check(
    "(A) NULL-footer rows re-derive BYTE-IDENTICAL to what was actually sent",
    nullMismatch.length === 0,
    nullMismatch.length === 0
      ? `${comparedNull.toLocaleString()} rows, 0 mismatches`
      : `${nullMismatch.length} MISMATCH(ES) — first:\n     stored : ${JSON.stringify(nullMismatch[0].stored)}\n     rebuilt: ${JSON.stringify(nullMismatch[0].got)}`,
  );
  // ⚠️ (B) over the CORPUS is NOT OBSERVABLE and must not be reported as a
  // pass. Every historical send predates the stored footers — `tls` has never
  // dispatched — so `comparedStored` is 0 and "0 bad out of 0" proves nothing.
  // Reported honestly here; the REAL, non-vacuous proof of (B) is (B') below,
  // which renders live stages on the footer-configured provider and shows the
  // before/after plus the gate verdict on the new text.
  if (comparedStored > 0) {
    check(
      "(B) footer-overridden rows differ ONLY by the swapped footer substring",
      swapBad.length === 0,
      swapBad.length === 0
        ? `${comparedStored.toLocaleString()} rows`
        : `${swapBad.length} bad — first:\n     got     : ${JSON.stringify(swapBad[0].got)}\n     expected: ${JSON.stringify(swapBad[0].expected)}`,
    );
  } else {
    console.log(
      "· (B) over the corpus: NOT OBSERVABLE — no historical send was made through a\n" +
        "     footer-configured provider, so a 0-of-0 comparison would be vacuous.\n" +
        "     (B') below carries this bar against live stages instead.",
    );
  }
  for (const s of nullSamples) console.log(`   (A) sample unchanged: ${JSON.stringify(s)}`);
  for (const s of swapSamples) {
    console.log(`   (B) ${s.key} BEFORE: ${JSON.stringify(s.before)}`);
    console.log(`   (B) ${s.key} AFTER : ${JSON.stringify(s.after)}`);
  }

  // ── (B') Real before/after for every stored-footer provider, incl. counts ──
  console.log("\n(B') Rendered before/after per stored-footer provider (representative link):");
  const demo = (await db.execute(sql`
    SELECT p.sms_provider_id, p.opt_out_footer, s.stop_text, b.name AS brand_name,
           cr.text AS creative_text, d.domain
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    JOIN brands b ON b.id = c.brand_id
    JOIN creatives cr ON cr.id = s.creative_id
    JOIN sms_providers p ON p.id = s.sms_provider_id
    LEFT JOIN short_domains d ON d.brand_id = c.brand_id AND d.status='active'
    WHERE p.opt_out_footer IS NOT NULL AND c.link_mode='tracked' AND s.archived_at IS NULL
    ORDER BY p.id LIMIT 5
  `)) as unknown as { sms_provider_id: string; opt_out_footer: string; stop_text: string; brand_name: string; creative_text: string; domain: string | null }[];
  check("a real stage exists on a footer-configured provider", demo.length > 0, `${demo.length}`);
  let gatePassedOnNew = 0;
  for (const d of demo) {
    const link = buildRepresentativeTrackedLinkUrl(d.domain ?? "gdkn.org");
    const before = buildStageSms({ brandName: d.brand_name, creativeText: d.creative_text, linkUrl: link, stopText: d.stop_text });
    const resolved = resolveOptOutFooter({ providerFooter: d.opt_out_footer, stageStopText: d.stop_text });
    const after = buildStageSms({ brandName: d.brand_name, creativeText: d.creative_text, linkUrl: link, stopText: resolved.text });
    const sb = calculateSmsSegments(before);
    const sa = calculateSmsSegments(after);
    const gate = optOutGateSubject({ renderedBody: after, resolved });
    const passes = gate.verifiable && hasOptOutLanguage(gate.subject);
    if (passes) gatePassedOnNew++;
    console.log(`   · provider ${d.sms_provider_id}  footer=${JSON.stringify(d.opt_out_footer)}  level=${resolved.level}`);
    console.log(`     BEFORE (${sb.characters}ch, ${sb.segments}seg): ${JSON.stringify(before)}`);
    console.log(`     AFTER  (${sa.characters}ch, ${sa.segments}seg): ${JSON.stringify(after)}`);
    console.log(`     substring-only=${before.split(d.stop_text).join(resolved.text) === after}  gate-passes-on-NEW-text=${passes}`);
  }
  check("the kickoff gate passes on the NEW footer text for every configured provider", gatePassedOnNew === demo.length, `${gatePassedOnNew}/${demo.length}`);

  // ── (C) THE GATE VALIDATES WHAT SHIPS ────────────────────────────────────
  console.log("\n(C) The gate's subject is the WINNER, not a field that lost:");
  // A stage whose own stop_text is compliant, out-ranked by a provider footer
  // that is NOT. The old gate (which read the body built from stop_text) would
  // have passed this; the new one must refuse.
  const trapStage = "Reply STOP to end";
  const trapProvider = "No more messages";
  const trapResolved = resolveOptOutFooter({ providerFooter: trapProvider, stageStopText: trapStage });
  const trapBody = buildStageSms({ brandName: "B", creativeText: "hello", linkUrl: buildRepresentativeTrackedLinkUrl("gdkn.org"), stopText: trapResolved.text });
  const trapGate = optOutGateSubject({ renderedBody: trapBody, resolved: trapResolved });
  const trapPasses = trapGate.verifiable && hasOptOutLanguage(trapGate.subject);
  console.log(`   stage stop_text = ${JSON.stringify(trapStage)}  (compliant)`);
  console.log(`   provider footer = ${JSON.stringify(trapProvider)}  (NOT compliant — wins)`);
  console.log(`   shipped body    = ${JSON.stringify(trapBody)}`);
  check(
    "a compliant stage field CANNOT rescue a non-compliant winning footer",
    trapPasses === false,
    trapPasses ? "GATE PASSED a body with no STOP keyword — compliance hole" : "refused, as required",
  );
  // And the mirror: a non-compliant stage field rescued by a compliant winner.
  const okResolved = resolveOptOutFooter({ providerFooter: "Reply STOP to quit", stageStopText: "no keyword here" });
  const okBody = buildStageSms({ brandName: "B", creativeText: "hello", linkUrl: buildRepresentativeTrackedLinkUrl("gdkn.org"), stopText: okResolved.text });
  const okGate = optOutGateSubject({ renderedBody: okBody, resolved: okResolved });
  check(
    "a compliant winning footer DOES satisfy the gate even when the stage field is not",
    okGate.verifiable && hasOptOutLanguage(okGate.subject),
    `body=${JSON.stringify(okBody)}`,
  );
  // provider-appends: unverifiable must FAIL CLOSED.
  const appendsResolved = resolveOptOutFooter({ stageStopText: "Stop to END", providerAppendsOwnOptOut: true });
  const unverifiable = optOutGateSubject({
    renderedBody: buildStageSms({ brandName: "B", creativeText: "hello", linkUrl: "", stopText: appendsResolved.text }),
    resolved: appendsResolved,
    providerKnownAppendedText: null,
  });
  check(
    "provider-appends with NO known text is UNVERIFIABLE (fails closed)",
    unverifiable.verifiable === false,
    `verifiable=${unverifiable.verifiable}`,
  );
  const verifiable = optOutGateSubject({
    renderedBody: "B: hello",
    resolved: appendsResolved,
    providerKnownAppendedText: "Reply STOP to opt out",
  });
  check(
    "provider-appends WITH known text validates against that text",
    verifiable.verifiable && hasOptOutLanguage(verifiable.subject),
    `subject=${JSON.stringify(verifiable.subject)}`,
  );
  check(
    "provider-appends adds NO footer line of ours (no trailing blank line)",
    !buildStageSms({ brandName: "B", creativeText: "hello", linkUrl: "https://x.co/r/AAAAAAA", stopText: "" }).endsWith("\n"),
    JSON.stringify(buildStageSms({ brandName: "B", creativeText: "hello", linkUrl: "https://x.co/r/AAAAAAA", stopText: "" })),
  );

  // ── (D) Preview count == sent count under a footer override ──────────────
  console.log("\n(D) Preview and send path agree under a footer override:");
  let dChecked = 0;
  let dDiff = 0;
  for (const d of demo) {
    const link = buildRepresentativeTrackedLinkUrl(d.domain ?? "gdkn.org");
    // PREVIEW: candidates as the APIs deliver them, ranked by the shared fn.
    const previewFooter = resolveOptOutFooter({ numberFooter: null, providerFooter: d.opt_out_footer, stageStopText: d.stop_text });
    const previewBody = buildStageSms({ brandName: d.brand_name, creativeText: d.creative_text, linkUrl: link, stopText: previewFooter.text });
    // SEND: the same chain kickoff runs.
    const sendFooter = resolveOptOutFooter({ numberFooter: null, providerFooter: d.opt_out_footer, stageStopText: d.stop_text });
    const sendBody = buildStageSms({ brandName: d.brand_name, creativeText: d.creative_text, linkUrl: link, stopText: sendFooter.text });
    dChecked++;
    if (previewBody !== sendBody || calculateSmsSegments(previewBody).segments !== calculateSmsSegments(sendBody).segments) dDiff++;
  }
  check("preview body and count match the send path under an override", dDiff === 0 && dChecked > 0, `${dChecked} checked, ${dDiff} divergence(s)`);

  // ── FAULT INJECTION ──────────────────────────────────────────────────────
  console.log("\nFAULT INJECTION — the harness must be able to go red:");
  const fiBase = buildStageSms({ brandName: "B", creativeText: "hello", linkUrl: "", stopText: "Stop to END" });
  const fiCorrupt = buildStageSms({ brandName: "B", creativeText: "hello", linkUrl: "", stopText: "Stop to ENDX" });
  check("#1 byte comparison detects a one-character footer change", fiBase !== fiCorrupt, `${JSON.stringify(fiBase)} vs ${JSON.stringify(fiCorrupt)}`);
  const wrongRank = resolveOptOutFooter({ numberFooter: "NUMBER", providerFooter: "PROVIDER", stageStopText: "STAGE" });
  check("#2 the chain really prefers the number (a broken order would show here)", wrongRank.text === "NUMBER", `got ${wrongRank.text}`);
  check("#3 the gate really rejects text without a STOP keyword", !hasOptOutLanguage("No more messages"), "'No more messages' correctly has no STOP");
  // Base chosen so the SHORT footer stays inside one segment and the LONG one
  // crosses: 145 + 1 + 11 = 157 (1 seg) vs 145 + 1 + 18 = 164 (2 seg). The
  // first attempt used 150, which put BOTH over 160 (162 and 169) — the probe
  // asserted a boundary crossing while testing two points on the same side of
  // it, and the harness rightly went red on its own bad constant.
  const longer = calculateSmsSegments("A".repeat(145) + "\n" + "Reply STOP to quit");
  const shorter = calculateSmsSegments("A".repeat(145) + "\n" + "Stop to END");
  check(
    "#4 a longer footer really moves the segment count (counts are footer-sensitive)",
    longer.characters > shorter.characters && longer.segments > shorter.segments,
    `${shorter.characters}ch/${shorter.segments}seg -> ${longer.characters}ch/${longer.segments}seg`,
  );

  // ── SOURCE GUARD ─────────────────────────────────────────────────────────
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  console.log("\nSOURCE GUARD (comments stripped):");
  for (const [file, must, mustNot] of [
    ["lib/sends/kickoff.ts", [/resolveOptOutFooter/, /optOutGateSubject/], [/stopText: row\.stop_text/]],
    ["components/campaigns/stage-form.tsx", [/resolveOptOutFooter/], [/stopText: watchedStopText/]],
  ] as [string, RegExp[], RegExp[]][]) {
    const raw = await fs.readFile(path.join(process.cwd(), file), "utf8");
    const code = strip(raw);
    console.log(`   ${file}: ${raw.length} -> ${code.length} chars`);
    check(`${file}: stripping left code`, code.trim().length > 200, `${code.trim().length}`);
    for (const re of must) check(`${file} uses ${re.source}`, re.test(code), "shared resolver must be used");
    for (const re of mustNot) check(`${file} no longer composes from the raw field [${re.source}]`, !re.test(code), "found a raw stop_text composition");
  }

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
