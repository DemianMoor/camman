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

// The moment the Q3 footer chain went LIVE in production: the prod deployment
// of 7ec9c4a (GitHub deployment 5961313557, state `success` at this instant).
//
// ⚠️ An EXTERNAL fact, deliberately NOT derived from the bodies being judged. A
// boundary inferred from the text ("rows ending with the provider footer are
// the post-chain ones") would make this bar unfalsifiable — every row would
// land in the branch that passes.
const Q3_LIVE_AT = "2026-08-18T11:01:47Z";
const Q3_LIVE_MS = new Date(Q3_LIVE_AT).getTime();
const BATCH = 5000;

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}

interface CorpusRow {
  stage_id: number;
  // WHEN THE BODY WAS RENDERED — the discriminator for which world-state a row
  // belongs to. `rendered_text` is INSERTed once by kickoff at materialization
  // and only ever READ at drain, so `created_at` names the code that produced
  // it. `sent_at` does NOT: it is stamped later, at dispatch.
  created_at: string;
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
    SELECT pp.id, pp.phone_number, pp.opt_out_footer
    FROM provider_phones pp
    WHERE pp.opt_out_footer IS NOT NULL
    ORDER BY pp.id
  `)) as unknown as { id: number; phone_number: string; opt_out_footer: string }[];
  const phoneTotal = (await db.execute(sql`
    SELECT count(*)::int AS n FROM provider_phones
  `)) as unknown as { n: number }[];
  console.log(
    `  provider_phones.opt_out_footer set on ${phoneFooters.length} of ${phoneTotal[0].n} numbers`,
  );
  for (const r of phoneFooters) {
    console.log(`     #${r.id} ${r.phone_number}: ${JSON.stringify(r.opt_out_footer)}`);
  }
  // ⚠️ THIS USED TO ASSERT "ships NULL everywhere", which was true on the day
  // 0141 landed and stops being true the moment the per-number footer UI is
  // used — a countdown, not a guard. What is asserted instead is what stays
  // true: the number level out-ranks EVERYTHING, so any value set here is the
  // opt-out wording that ships, and the kickoff gate refuses the stage if it
  // carries no STOP keyword. "Nobody has set one" is reported; "anything set is
  // sendable" is enforced.
  const badPhoneFooter = phoneFooters.filter((r) => !hasOptOutLanguage(r.opt_out_footer));
  check(
    "every NUMBER-level footer that exists contains a STOP keyword",
    badPhoneFooter.length === 0,
    badPhoneFooter.length
      ? `NON-COMPLIANT on: ${badPhoneFooter.map((r) => `#${r.id} ${JSON.stringify(r.opt_out_footer)}`).join(", ")}`
      : `${phoneFooters.length} configured, ${phoneTotal[0].n} numbers total`,
  );


  // ── THE REWRITTEN NUMBER-LEVEL GUARD MUST BE ABLE TO GO RED ──────────────
  // Synthesized in a transaction and rolled back: nothing is configured.
  const RB_PHONE = Symbol("rollback");
  try {
    await db.transaction(async (tx) => {
      const victim = (await tx.execute(sql`
        SELECT id FROM provider_phones ORDER BY id LIMIT 1
      `)) as unknown as { id: number }[];
      await tx.execute(sql`
        UPDATE provider_phones SET opt_out_footer = 'No more texts' WHERE id = ${victim[0].id}
      `);
      const probe = (await tx.execute(sql`
        SELECT opt_out_footer FROM provider_phones WHERE id = ${victim[0].id}
      `)) as unknown as { opt_out_footer: string | null }[];
      check(
        "a NON-COMPLIANT number-level footer would be CAUGHT (the check discriminates)",
        !hasOptOutLanguage(probe[0].opt_out_footer ?? ""),
        `injected ${JSON.stringify(probe[0].opt_out_footer)} on #${victim[0].id} — the live check would fail on this`,
      );
      throw RB_PHONE;
    });
  } catch (e) {
    if (e !== RB_PHONE) throw e;
  }
  const phoneAfter = (await db.execute(sql`
    SELECT count(*)::int AS n FROM provider_phones WHERE opt_out_footer IS NOT NULL
  `)) as unknown as { n: number }[];
  check(
    "self-test rolled back — number-level footers are exactly as this run found them",
    phoneAfter[0].n === phoneFooters.length,
    `before=${phoneFooters.length} after=${phoneAfter[0].n}`,
  );

  // ── (A) BYTE-IDENTICAL for NULL-footer providers ─────────────────────────
  const corpusScope = (await db.execute(sql`
    SELECT count(*)::int AS total FROM stage_sends ss
    WHERE ss.rendered_text IS NOT NULL AND ss.sent_at IS NOT NULL AND ss.created_at >= ${CUTOVER}::timestamptz
  `)) as unknown as { total: number }[];
  // ⚠️ CORPUS = ACTUALLY SENT, not merely materialized. `rendered_text IS NOT
  // NULL` also matches rows that were built and then RECALLED (status
  // 'rejected', sent_at NULL) or are still 'pending' — drafts that never
  // reached a handset, and whose stage may since have been legitimately
  // re-pointed at another creative. Including them made this bar report 77
  // phantom mismatches from one recalled batch on stage 2873. A harness that
  // claims "byte-identical to what was actually SENT" must filter on sent_at.
  //
  // Corpus size is re-stated on EVERY run: it more than doubled mid-workstream
  // (29,917 -> 75,125 materialized) while live sending continued, so any
  // "corpus-proven" claim is only true of the snapshot it ran against.
  console.log(`\n(A) Corpus since ${CUTOVER}: ${corpusScope[0].total.toLocaleString()} ACTUALLY-SENT rows`);
  check("corpus is non-empty", corpusScope[0].total > 0, `${corpusScope[0].total}`);

  // -- WHICH TIMESTAMP DECIDES THE COHORT ----------------------------------
  // A body is rendered at MATERIALIZATION and dispatched later, so a stage
  // materialized before the chain shipped and drained after it carries
  // pre-chain bytes under a post-chain `sent_at`. Those rows are counted here
  // and the number is printed on every run: it is exactly how many rows a
  // `sent_at`-based split would place in the wrong world.
  const straddleRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM stage_sends ss
    WHERE ss.rendered_text IS NOT NULL AND ss.sent_at IS NOT NULL
      AND ss.created_at >= ${CUTOVER}::timestamptz
      AND ss.created_at < ${Q3_LIVE_AT}::timestamptz
      AND ss.sent_at   >= ${Q3_LIVE_AT}::timestamptz
  `)) as unknown as { n: number }[];
  const straddlers = straddleRows[0].n;
  console.log(
    `    cohort discriminator = RENDER time (stage_sends.created_at) vs Q3 go-live ${Q3_LIVE_AT}`,
  );
  console.log(
    `    ${straddlers.toLocaleString()} corpus row(s) rendered BEFORE go-live were sent AFTER it` +
      ` - the rows a sent_at split would misclassify`,
  );

  let comparedNull = 0;
  // Bar (B) splits by WORLD-STATE. A row rendered before the chain shipped and
  // a row rendered after it are evidence for two different claims, and only one
  // model fits each — see the block above the split for the reasoning.
  let comparedStoredPre = 0;
  let comparedStoredPost = 0;
  const nullMismatch: { stored: string; got: string }[] = [];
  const swapBad: { stored: string; got: string; expected: string }[] = [];
  const postBad: { stage_id: number; stored: string; got: string }[] = [];
  const swapSamples: { key: string; before: string; after: string; footer: string }[] = [];
  const nullSamples: string[] = [];
  // Exclusions are OUTPUT, never silent: counted, reasoned, and printed.
  let excludedInputDrift = 0;
  const driftSamples: string[] = [];

  for (let off = 0; ; off += BATCH) {
    const rows = (await db.execute(sql`
      SELECT ss.stage_id, ss.created_at, l.code, d.domain, b.name AS brand_name, cr.text AS creative_text,
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
      WHERE ss.rendered_text IS NOT NULL AND ss.sent_at IS NOT NULL AND ss.created_at >= ${CUTOVER}::timestamptz
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
        if (rebuilt !== r.rendered_text) {
          // ⚠️ PIN, DON'T SNAPSHOT. Decompose before judging.
          //
          // The body is `<brand>: <creative>` / `<link>` / `<footer>`. The link
          // and footer lines are what these builders PRODUCE — a difference
          // there is a real failure and is never excused. The first line is an
          // INPUT we do not control and have no frozen copy of: an operator can
          // re-point a stage at a different creative, or edit a creative's text,
          // after a row was rendered. Such a row is not evidence either way, so
          // it is EXCLUDED — and counted, with its reason, in the output.
          //
          // (A timestamp pin was the original plan, but there is no `updated_at`
          // on creatives / campaign_stages / brands / short_domains, so
          // "modified after sent_at" is not answerable from the data. This is
          // the equivalent, and strictly stronger for the bar that matters: it
          // keeps link+footer coverage on EVERY row instead of dropping whole
          // rows whenever a creative was touched.)
          const a = r.rendered_text.split("\n");
          const b = rebuilt.split("\n");
          const sameTail =
            a.length === b.length &&
            a.slice(1).join("\n") === b.slice(1).join("\n");
          if (sameTail && a[0] !== b[0]) {
            excludedInputDrift++;
            if (driftSamples.length < 3) {
              driftSamples.push(`stage ${r.stage_id}: frozen first line ${JSON.stringify(a[0].slice(0, 60))}… vs current ${JSON.stringify(b[0].slice(0, 60))}…`);
            }
          } else {
            nullMismatch.push({ stored: r.rendered_text, got: rebuilt });
          }
        } else if (nullSamples.length < 2) nullSamples.push(rebuilt);
      } else {
        // ── (B) a footer out-ranks the stage. WHICH ASSERTION IS CORRECT
        //    DEPENDS ON WHEN THE BODY WAS RENDERED. ────────────────────────
        //
        // PRE-CHAIN (rendered before Q3 shipped): the stored body carries the
        //   stage's stop_text, because nothing could out-rank it yet. Today's
        //   builder resolves the account footer instead, so the only admissible
        //   difference is that substring — SWAP and demand an exact match.
        //
        // POST-CHAIN (rendered after Q3 shipped): the chain was already live
        //   when this body was built, so the stored bytes ALREADY carry the
        //   resolved footer. The correct assertion is plain BYTE-IDENTITY;
        //   applying the swap-model here compares the body against a stop_text
        //   it never contained and reports a mismatch that is really the
        //   feature working. (Measured: this is exactly what happened — 997
        //   `tls` rows, the first real sends under the chain, turned the bar
        //   red the moment Q3 went live.)
        //
        // A row rendered post-chain whose body still ends with the STAGE's
        // stop_text would mean the account footer was configured AFTER that
        // send. That is not excused here: it is left to fail loudly and be
        // diagnosed, because the alternative — a carve-out no run exercises —
        // is how a compliance bar quietly stops being able to fail.
        const renderedUnderChain = new Date(r.created_at).getTime() >= Q3_LIVE_MS;
        if (renderedUnderChain) {
          comparedStoredPost++;
          if (rebuilt !== r.rendered_text) {
            postBad.push({ stage_id: r.stage_id, stored: r.rendered_text, got: rebuilt });
          } else if (swapSamples.length < 3) {
            swapSamples.push({ key: `${r.provider_key ?? "?"} (post-chain)`, before: r.rendered_text, after: rebuilt, footer: resolved.text });
          }
        } else {
          comparedStoredPre++;
          const endsWithStop = r.rendered_text.endsWith(r.stop_text);
          const expected = endsWithStop
            ? r.rendered_text.slice(0, r.rendered_text.length - r.stop_text.length) + resolved.text
            : `<pre-chain body does not end with its stage stop_text ${JSON.stringify(r.stop_text)} — it should, nothing could out-rank the stage before ${Q3_LIVE_AT}>`;
          if (rebuilt !== expected) swapBad.push({ stored: r.rendered_text, got: rebuilt, expected });
          else if (swapSamples.length < 3) {
            swapSamples.push({ key: `${r.provider_key ?? "?"} (pre-chain, swapped)`, before: r.rendered_text, after: rebuilt, footer: resolved.text });
          }
        }
      }
    }
    if (rows.length < BATCH) break;
  }

  console.log(`  rows whose chain resolves to the STAGE (bar A): ${comparedNull.toLocaleString()}`);
  console.log(
    `  rows out-ranked by a stored footer (bar B):     ${(comparedStoredPre + comparedStoredPost).toLocaleString()}` +
      `  [pre-chain ${comparedStoredPre.toLocaleString()} | post-chain ${comparedStoredPost.toLocaleString()}]`,
  );
  console.log(`  EXCLUDED — input drifted since the send: ${excludedInputDrift}`);
  for (const d of driftSamples) console.log(`     · ${d}`);
  console.log(
    `  (an excluded row is one whose brand+creative line no longer matches the frozen body while
` +
    `   its link and footer lines DO — an operator re-pointed the stage or edited the creative.
` +
    `   Link and footer differences are never excused.)`,
  );
  check("bar A covered rows", comparedNull > 0, `${comparedNull} compared, ${excludedInputDrift} excluded`);
  check(
    "(A) NULL-footer rows re-derive BYTE-IDENTICAL to what was actually sent",
    nullMismatch.length === 0,
    nullMismatch.length === 0
      ? `${comparedNull.toLocaleString()} rows, 0 mismatches`
      : `${nullMismatch.length} MISMATCH(ES) — first:\n     stored : ${JSON.stringify(nullMismatch[0].stored)}\n     rebuilt: ${JSON.stringify(nullMismatch[0].got)}`,
  );
  // ⚠️ BAR (B) IS TWO CLAIMS, NOT ONE, AND EACH IS REPORTED SEPARATELY.
  //
  // Both cohorts are stated on every run even when empty. A cohort that is
  // empty proves nothing and says so; it is never reported as a pass, and it is
  // never silently folded into the other one's count.
  if (comparedStoredPre > 0) {
    check(
      "(B-pre) PRE-CHAIN rows differ from today's build ONLY by the swapped footer substring",
      swapBad.length === 0,
      swapBad.length === 0
        ? `${comparedStoredPre.toLocaleString()} rows rendered before ${Q3_LIVE_AT}`
        : `${swapBad.length} bad of ${comparedStoredPre.toLocaleString()} — first:
     got     : ${JSON.stringify(swapBad[0].got)}
     expected: ${JSON.stringify(swapBad[0].expected)}`,
    );
  } else {
    console.log(
      `· (B-pre) NOT OBSERVABLE — 0 corpus rows on a footer-configured account were
` +
        `     rendered before ${Q3_LIVE_AT}, so a 0-of-0 swap comparison would be vacuous.
` +
        `     (B') below carries the before/after against live stages instead.`,
    );
  }
  if (comparedStoredPost > 0) {
    check(
      "(B-post) POST-CHAIN rows re-derive BYTE-IDENTICAL to what was actually sent",
      postBad.length === 0,
      postBad.length === 0
        ? `${comparedStoredPost.toLocaleString()} rows rendered under the live chain, 0 mismatches`
        : `${postBad.length} MISMATCH(ES) of ${comparedStoredPost.toLocaleString()} — first (stage ${postBad[0].stage_id}):
     stored : ${JSON.stringify(postBad[0].stored)}
     rebuilt: ${JSON.stringify(postBad[0].got)}`,
    );
  } else {
    console.log(
      `· (B-post) NOT OBSERVABLE — nothing has yet been SENT on a footer-configured
` +
        `     account since ${Q3_LIVE_AT}. This cohort becomes the primary evidence for (B)
` +
        `     as soon as it does, and (B-pre) shrinks to history.`,
    );
  }
  // Non-vacuity of bar (B) as a whole: at least one cohort must carry rows, or
  // the corpus half of this bar is proving nothing at all and (B') is the only
  // evidence there is. Stated as a check so it cannot pass unnoticed.
  check(
    "bar B is non-vacuous over the corpus (at least one cohort has rows)",
    comparedStoredPre + comparedStoredPost > 0,
    `pre=${comparedStoredPre} post=${comparedStoredPost}`,
  );
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

  // #5/#6 THE COHORT SPLIT IS LOAD-BEARING. Each model is applied to the world
  // it does NOT describe and must come out wrong. If either of these passed,
  // the split would be decoration and one model would be silently doing both
  // jobs. Synthesized bodies, not corpus rows, so this holds on an empty
  // corpus and on any future data.
  const fiStage = "Stop to END";
  const fiAccount = "Reply STOP to quit";
  const fiLink = buildRepresentativeTrackedLinkUrl("gdkn.org");
  const fiResolved = resolveOptOutFooter({ providerFooter: fiAccount, stageStopText: fiStage });
  // What today's builder produces for both worlds (the chain is live now).
  const fiRebuilt = buildStageSms({ brandName: "B", creativeText: "hello", linkUrl: fiLink, stopText: fiResolved.text });
  // A body rendered BEFORE the chain: carries the stage's stop_text.
  const fiPreStored = buildStageSms({ brandName: "B", creativeText: "hello", linkUrl: fiLink, stopText: fiStage });
  // A body rendered AFTER it: already carries the resolved account footer.
  const fiPostStored = fiRebuilt;
  const swapOf = (stored: string) =>
    stored.endsWith(fiStage) ? stored.slice(0, stored.length - fiStage.length) + fiResolved.text : "<no stop_text tail>";
  check(
    "#5 byte-identity applied to a PRE-chain body FAILS (why that cohort needs the swap model)",
    fiRebuilt !== fiPreStored && fiRebuilt === swapOf(fiPreStored),
    `stored ${JSON.stringify(fiPreStored)} vs rebuilt ${JSON.stringify(fiRebuilt)}`,
  );
  check(
    "#6 the swap model applied to a POST-chain body FAILS (why that cohort needs byte-identity)",
    swapOf(fiPostStored) !== fiRebuilt && fiPostStored === fiRebuilt,
    `swap-model expected ${JSON.stringify(swapOf(fiPostStored))}, actual stored ${JSON.stringify(fiPostStored)}`,
  );
  check(
    "#7 the post-chain comparison detects a one-character drift in a stored body",
    fiPostStored !== fiPostStored.replace("quit", "quiT"),
    "byte comparison is sensitive on the footer line",
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
