// B2 — segment-length recalculation from the RESOLVED short domain.
//
// The claim under test: the link string is now built once, from one resolver,
// and every site that measures a message measures the same bytes the recipient
// receives. The link sits INSIDE the counted body, so a disagreement about
// which host wins silently moves the GSM-7 segment boundary — gdkn.org is 8
// characters, g.guidekn.com is 13 — and a stage can preview as 1 segment and
// send as 2, at double the cost, with nothing on screen to show it.
//
// Three bars, in order of severity:
//   (a) BYTE-IDENTICAL RE-DERIVATION of every corpus row that was actually
//       sent. One mismatch is a hard stop.
//   (b) A host change alters the body by EXACTLY the domain substring, with
//       counts recomputed from the true length.
//   (c) Preview and send path resolve the SAME domain for the same
//       (stage, phone) — proven by differential, not asserted.
//
// FAULT INJECTION: after the real comparisons, inputs are deliberately
// corrupted and the harness must report the mismatch. A green run is only
// evidence if the harness is capable of going red.
import "./_env-preload";

import { promises as fs } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import { calculateSmsSegments } from "@/lib/creative-helpers";
import {
  buildRepresentativeTrackedLinkUrl,
  buildTrackedLinkUrl,
  pickEffectiveShortDomain,
  TRACKED_CODE_LENGTH,
} from "@/lib/links/tracked-link";
import { resolveShortDomainForSend } from "@/lib/sends/resolve-short-domain";
import { buildStageSms } from "@/lib/sends/stage-sms";

const CUTOVER = "2026-08-17T12:21:28Z";
const BATCH = 5000;

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

interface CorpusRow {
  id: string;
  code: string;
  domain: string;
  brand_name: string;
  creative_text: string;
  stop_text: string;
  rendered_text: string;
}

async function main() {
  // ── SCOPE ────────────────────────────────────────────────────────────────
  const scope = (await db.execute(sql`
    SELECT count(*)::int AS total,
           count(DISTINCT d.domain)::int AS domains,
           count(*) FILTER (WHERE ss.link_id IS NULL)::int AS missing_link,
           count(*) FILTER (WHERE cr.text IS NULL)::int AS missing_creative
    FROM stage_sends ss
    JOIN campaign_stages s ON s.id = ss.stage_id
    LEFT JOIN creatives cr ON cr.id = s.creative_id
    LEFT JOIN links l ON l.id = ss.link_id
    LEFT JOIN short_domains d ON d.id = l.short_domain_id
    WHERE ss.rendered_text IS NOT NULL AND ss.created_at >= ${CUTOVER}::timestamptz
  `)) as unknown as {
    total: number; domains: number; missing_link: number; missing_creative: number;
  }[];
  const perHost = (await db.execute(sql`
    SELECT d.domain, length(d.domain)::int AS host_len, count(*)::int AS n
    FROM stage_sends ss
    JOIN links l ON l.id = ss.link_id
    JOIN short_domains d ON d.id = l.short_domain_id
    WHERE ss.rendered_text IS NOT NULL AND ss.created_at >= ${CUTOVER}::timestamptz
    GROUP BY d.domain, length(d.domain) ORDER BY count(*) DESC
  `)) as unknown as { domain: string; host_len: number; n: number }[];

  console.log(`\nCORPUS SCOPE — stage_sends.rendered_text since ${CUTOVER}`);
  console.log(`  rows: ${scope[0].total.toLocaleString()}  ·  distinct hosts: ${scope[0].domains}`);
  for (const h of perHost) {
    console.log(`     ${h.domain} (${h.host_len} chars): ${h.n.toLocaleString()} rows`);
  }
  console.log(
    `  rows missing a link: ${scope[0].missing_link} · missing a creative: ${scope[0].missing_creative}`,
  );

  // Non-empty before equal: an empty corpus makes every comparison vacuous.
  check("corpus is non-empty", scope[0].total > 0, `${scope[0].total} rows`);
  check(
    "every corpus row has the inputs needed to re-derive it",
    scope[0].missing_link === 0 && scope[0].missing_creative === 0,
    `missing_link=${scope[0].missing_link} missing_creative=${scope[0].missing_creative}`,
  );
  check("mint code length is the shared constant", TRACKED_CODE_LENGTH === 7, `${TRACKED_CODE_LENGTH}`);
  if (scope[0].total === 0) {
    await pgConn.end({ timeout: 5 });
    process.exit(1);
  }

  // ── (a) BYTE-IDENTICAL RE-DERIVATION ─────────────────────────────────────
  console.log(`\n(a) Re-deriving all ${scope[0].total.toLocaleString()} corpus rows through the NEW builders…`);
  let compared = 0;
  const mismatches: { row: CorpusRow; got: string }[] = [];
  const samples: CorpusRow[] = [];
  const segStored = new Map<number, number>();
  const segRebuilt = new Map<number, number>();

  for (let off = 0; ; off += BATCH) {
    const rows = (await db.execute(sql`
      SELECT ss.id::text AS id, l.code, d.domain, b.name AS brand_name,
             cr.text AS creative_text, s.stop_text, ss.rendered_text
      FROM stage_sends ss
      JOIN campaign_stages s ON s.id = ss.stage_id
      JOIN campaigns c ON c.id = s.campaign_id
      JOIN brands b ON b.id = c.brand_id
      JOIN creatives cr ON cr.id = s.creative_id
      JOIN links l ON l.id = ss.link_id
      JOIN short_domains d ON d.id = l.short_domain_id
      WHERE ss.rendered_text IS NOT NULL AND ss.created_at >= ${CUTOVER}::timestamptz
      ORDER BY ss.id
      LIMIT ${BATCH} OFFSET ${off}
    `)) as unknown as CorpusRow[];
    if (rows.length === 0) break;
    for (const r of rows) {
      const rebuilt = buildStageSms({
        brandName: r.brand_name,
        creativeText: r.creative_text,
        linkUrl: buildTrackedLinkUrl(r.domain, r.code),
        stopText: r.stop_text,
      });
      compared++;
      const a = calculateSmsSegments(r.rendered_text).segments;
      const b = calculateSmsSegments(rebuilt).segments;
      segStored.set(a, (segStored.get(a) ?? 0) + 1);
      segRebuilt.set(b, (segRebuilt.get(b) ?? 0) + 1);
      if (rebuilt !== r.rendered_text) mismatches.push({ row: r, got: rebuilt });
      // Prefer longer-host samples so the report shows the interesting case.
      if (samples.length < 6 && (r.domain.length > 8 || samples.length < 3)) samples.push(r);
    }
    if (rows.length < BATCH) break;
  }

  console.log(`  compared: ${compared.toLocaleString()}`);
  check("re-derivation covered the whole corpus", compared === scope[0].total, `${compared} of ${scope[0].total}`);
  check(
    "EVERY corpus row re-derives BYTE-IDENTICAL to what was actually sent",
    mismatches.length === 0,
    mismatches.length === 0
      ? `${compared.toLocaleString()} rows, 0 mismatches`
      : `${mismatches.length} MISMATCH(ES) — first:\n` +
        `     stored : ${JSON.stringify(mismatches[0].row.rendered_text)}\n` +
        `     rebuilt: ${JSON.stringify(mismatches[0].got)}\n` +
        `     hex stored : ${hex(mismatches[0].row.rendered_text).slice(0, 160)}\n` +
        `     hex rebuilt: ${hex(mismatches[0].got).slice(0, 160)}`,
  );
  const fmtDist = (m: Map<number, number>) =>
    [...m.entries()].sort((x, y) => x[0] - y[0]).map(([s, n]) => `${s}seg:${n.toLocaleString()}`).join("  ");
  console.log(`  segment distribution stored : ${fmtDist(segStored)}`);
  console.log(`  segment distribution rebuilt: ${fmtDist(segRebuilt)}`);
  check(
    "segment-count distribution is unchanged",
    fmtDist(segStored) === fmtDist(segRebuilt),
    `stored=[${fmtDist(segStored)}] rebuilt=[${fmtDist(segRebuilt)}]`,
  );

  console.log("\n  SAMPLES (actual rows, re-derived):");
  for (const s of samples.slice(0, 4)) {
    const rebuilt = buildStageSms({
      brandName: s.brand_name,
      creativeText: s.creative_text,
      linkUrl: buildTrackedLinkUrl(s.domain, s.code),
      stopText: s.stop_text,
    });
    const seg = calculateSmsSegments(rebuilt);
    console.log(
      `   · host=${s.domain} (${s.domain.length} chars)  chars=${seg.characters} segments=${seg.segments} ${seg.charset}`,
    );
    console.log(`     stored : ${JSON.stringify(s.rendered_text)}`);
    console.log(`     rebuilt: ${JSON.stringify(rebuilt)}`);
    console.log(`     identical=${rebuilt === s.rendered_text}  hex(head)=${hex(rebuilt).slice(0, 48)}…`);
  }

  // ── FAULT INJECTION #1 ───────────────────────────────────────────────────
  console.log("\nFAULT INJECTION #1 — corrupting the domain on a real row:");
  const victim = samples[0];
  const corruptedHost = victim.domain.replace(/^./, (c) => (c === "g" ? "h" : "g"));
  const corrupted = buildStageSms({
    brandName: victim.brand_name,
    creativeText: victim.creative_text,
    linkUrl: buildTrackedLinkUrl(corruptedHost, victim.code),
    stopText: victim.stop_text,
  });
  console.log(`   host ${victim.domain} -> ${corruptedHost}`);
  console.log(`   stored   : ${JSON.stringify(victim.rendered_text.slice(0, 80))}…`);
  console.log(`   corrupted: ${JSON.stringify(corrupted.slice(0, 80))}…`);
  check(
    "the byte comparison DETECTS a corrupted domain (harness can go red)",
    corrupted !== victim.rendered_text,
    corrupted !== victim.rendered_text
      ? "mismatch correctly reported"
      : "HARNESS IS BLIND — the green run above would prove nothing",
  );

  // ── FAULT INJECTION #2: the segment counter must be length-sensitive ──────
  const shortHost = "a.co";
  const longHost = "a-very-long-tracking-host.example";
  const base = "B: " + "x".repeat(120) + "\n";
  const segShort = calculateSmsSegments(base + buildRepresentativeTrackedLinkUrl(shortHost) + "\nStop to END");
  const segLong = calculateSmsSegments(base + buildRepresentativeTrackedLinkUrl(longHost) + "\nStop to END");
  console.log(
    `\nFAULT INJECTION #2 — host length must move the count: ${shortHost}=${segShort.characters}ch/${segShort.segments}seg, ` +
      `${longHost}=${segLong.characters}ch/${segLong.segments}seg`,
  );
  check(
    "a longer host really does change chars AND cross a segment boundary",
    segLong.characters > segShort.characters && segLong.segments > segShort.segments,
    `${segShort.characters}ch/${segShort.segments}seg -> ${segLong.characters}ch/${segLong.segments}seg`,
  );

  // ── (b) HOST CHANGE = EXACTLY THE DOMAIN SUBSTRING ───────────────────────
  console.log("\n(b) Host change vs the OLD brand-oldest-active preview:");
  const hosts = (await db.execute(sql`
    SELECT DISTINCT ON (d.domain) d.domain, b.name AS brand_name,
           cr.text AS creative_text, s.stop_text,
           (SELECT od.domain FROM short_domains od
             WHERE od.brand_id = c.brand_id AND od.status='active'
             ORDER BY od.created_at ASC, od.id ASC LIMIT 1) AS old_preview_domain
    FROM stage_sends ss
    JOIN campaign_stages s ON s.id = ss.stage_id
    JOIN campaigns c ON c.id = s.campaign_id
    JOIN brands b ON b.id = c.brand_id
    JOIN creatives cr ON cr.id = s.creative_id
    JOIN links l ON l.id = ss.link_id
    JOIN short_domains d ON d.id = l.short_domain_id
    WHERE ss.rendered_text IS NOT NULL AND ss.created_at >= ${CUTOVER}::timestamptz
    ORDER BY d.domain
  `)) as unknown as {
    domain: string; brand_name: string; creative_text: string;
    stop_text: string; old_preview_domain: string | null;
  }[];
  let substrOk = 0;
  let substrBad = 0;
  // Always exercise the rule at least once, with a synthetic pair if the live
  // data happens not to contain a divergence — otherwise this bar is vacuous.
  const pairs: { from: string; to: string; brand: string; text: string; stop: string }[] = [];
  for (const r of hosts) {
    if (r.old_preview_domain && r.old_preview_domain !== r.domain) {
      pairs.push({ from: r.old_preview_domain, to: r.domain, brand: r.brand_name, text: r.creative_text, stop: r.stop_text });
    }
  }
  const syntheticUsed = pairs.length === 0;
  if (syntheticUsed && hosts[0]) {
    pairs.push({ from: "gdkn.org", to: "g.guidekn.com", brand: hosts[0].brand_name, text: hosts[0].creative_text, stop: hosts[0].stop_text });
  }
  for (const p of pairs) {
    const oldBody = buildStageSms({ brandName: p.brand, creativeText: p.text, linkUrl: buildRepresentativeTrackedLinkUrl(p.from), stopText: p.stop });
    const newBody = buildStageSms({ brandName: p.brand, creativeText: p.text, linkUrl: buildRepresentativeTrackedLinkUrl(p.to), stopText: p.stop });
    const reconstructed = oldBody.split(p.from).join(p.to);
    const exact = reconstructed === newBody;
    if (exact) substrOk++;
    else substrBad++;
    const so = calculateSmsSegments(oldBody);
    const sn = calculateSmsSegments(newBody);
    console.log(
      `   · ${p.from}(${so.characters}ch,${so.segments}seg) -> ${p.to}(${sn.characters}ch,${sn.segments}seg)` +
        `  delta=${sn.characters - so.characters}ch  substring-only=${exact}`,
    );
  }
  console.log(`   pairs exercised: ${pairs.length}${syntheticUsed ? " (SYNTHETIC — no live host divergence in the corpus)" : " (from live data)"}`);
  check("host-change pairs were exercised", pairs.length > 0, `${pairs.length}`);
  check(
    "a host change alters the body by EXACTLY the domain substring",
    substrBad === 0 && substrOk > 0,
    `${substrOk} exact, ${substrBad} not`,
  );

  // ── (c) PREVIEW vs SEND PATH, per real (stage, phone) ────────────────────
  console.log("\n(c) Preview resolution vs send-path resolution, every tracked stage:");
  const stages = (await db.execute(sql`
    SELECT s.id AS stage_id, c.org_id, c.brand_id, s.provider_phone_id,
           b.name AS brand_name, cr.text AS creative_text, s.stop_text,
           (SELECT d.domain FROM short_domains d
             WHERE d.brand_id = c.brand_id AND d.org_id = c.org_id AND d.status='active'
             ORDER BY d.is_default DESC, d.created_at ASC, d.id ASC LIMIT 1) AS api_brand_domain,
           (SELECT d.domain FROM short_domains d
             WHERE d.id = ph.short_domain_id AND d.status='active' LIMIT 1) AS api_phone_domain
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    JOIN brands b ON b.id = c.brand_id
    JOIN creatives cr ON cr.id = s.creative_id
    LEFT JOIN provider_phones ph ON ph.id = s.provider_phone_id
    WHERE c.link_mode='tracked' AND s.archived_at IS NULL
  `)) as unknown as {
    stage_id: number; org_id: string; brand_id: number; provider_phone_id: number | null;
    brand_name: string; creative_text: string; stop_text: string;
    api_brand_domain: string | null; api_phone_domain: string | null;
  }[];
  check("tracked-stage scope is non-empty", stages.length > 0, `${stages.length} stages`);

  let cChecked = 0;
  let cDomainDiff = 0;
  let cBodyDiff = 0;
  let cSegDiff = 0;
  let cWithOverride = 0;
  const cSamples: string[] = [];
  for (const st of stages) {
    // PREVIEW path — the two candidates exactly as the APIs now deliver them,
    // ranked by the shared pure function the stage form calls.
    const previewDomain = pickEffectiveShortDomain({
      phoneOverrideDomain: st.api_phone_domain,
      brandDefaultDomain: st.api_brand_domain,
    });
    // SEND path — the server resolver kickoff uses.
    const sendResolved = await resolveShortDomainForSend(db, {
      orgId: st.org_id, brandId: st.brand_id, providerPhoneId: st.provider_phone_id,
    });
    const sendDomain = sendResolved?.domain ?? null;
    cChecked++;
    if (st.api_phone_domain) cWithOverride++;
    if (previewDomain !== sendDomain) {
      cDomainDiff++;
      cSamples.push(`   DOMAIN DIFF stage ${st.stage_id}: preview=${previewDomain} send=${sendDomain}`);
      continue;
    }
    if (previewDomain == null) continue;
    const previewBody = buildStageSms({
      brandName: st.brand_name, creativeText: st.creative_text,
      linkUrl: buildRepresentativeTrackedLinkUrl(previewDomain), stopText: st.stop_text,
    });
    const sendBody = buildStageSms({
      brandName: st.brand_name, creativeText: st.creative_text,
      linkUrl: buildRepresentativeTrackedLinkUrl(sendDomain!), stopText: st.stop_text,
    });
    if (previewBody !== sendBody) {
      cBodyDiff++;
      cSamples.push(`   BODY DIFF stage ${st.stage_id}`);
    }
    if (calculateSmsSegments(previewBody).segments !== calculateSmsSegments(sendBody).segments) {
      cSegDiff++;
      cSamples.push(`   SEGMENT DIFF stage ${st.stage_id}`);
    }
  }
  console.log(`  compared ${cChecked} tracked stages · ${cWithOverride} of them on a number WITH an active override`);
  for (const l of cSamples.slice(0, 8)) console.log(l);
  check("preview and send path resolve the SAME domain for every stage", cDomainDiff === 0, `${cDomainDiff} divergence(s) across ${cChecked}`);
  check("preview and send path produce the SAME body", cBodyDiff === 0, `${cBodyDiff} divergence(s)`);
  check("preview and send path produce the SAME segment count", cSegDiff === 0, `${cSegDiff} divergence(s)`);
  // Non-vacuous: the override case must actually be represented, or (c) only
  // proves the two paths agree where there was nothing to disagree about.
  check(
    "at least one compared stage sends on a number WITH an override (non-vacuous)",
    cWithOverride > 0,
    `${cWithOverride} of ${cChecked}`,
  );

  // ── FAULT INJECTION #3: prove (c)'s ranking comparison can fail ───────────
  const fakePreview = pickEffectiveShortDomain({
    phoneOverrideDomain: "wrong.example",
    brandDefaultDomain: "gdkn.org",
  });
  console.log(`\nFAULT INJECTION #3 — injected override 'wrong.example' over brand 'gdkn.org' ranks as: ${fakePreview}`);
  check(
    "the (c) ranking DETECTS a wrong preview candidate (harness can go red)",
    fakePreview === "wrong.example",
    `ranked ${fakePreview} — so a real preview/send divergence would surface as a DOMAIN DIFF`,
  );

  // ── SOURCE GUARD ─────────────────────────────────────────────────────────
  // Comments stripped first: a comment quoting the removed hand-built link is a
  // description, not a violation. (Three scanners in this workstream failed on
  // exactly that confusion.)
  const strip = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  const HANDBUILT = new RegExp("`https://\\$\\{");
  const SITES = [
    { f: "components/campaigns/stage-form.tsx", must: [/pickEffectiveShortDomain/, /buildRepresentativeTrackedLinkUrl/], mustNot: [HANDBUILT, /"XXXXXXX"/] },
    { f: "lib/sends/kickoff.ts", must: [/buildRepresentativeTrackedLinkUrl/, /buildTrackedLinkUrl/], mustNot: [HANDBUILT] },
    { f: "lib/sends/resolve-short-domain.ts", must: [/pickEffectiveShortDomain/], mustNot: [] },
  ];
  console.log("\nSOURCE GUARD (comments stripped — a comment quoting old code is not a violation):");
  for (const s of SITES) {
    const raw = await fs.readFile(path.join(process.cwd(), s.f), "utf8");
    const code = strip(raw);
    console.log(`   ${s.f}: ${raw.length} -> ${code.length} chars after stripping`);
    check(`${s.f}: stripping left code to scan`, code.trim().length > 200, `${code.trim().length} chars`);
    for (const re of s.must) check(`${s.f} uses ${re.source}`, re.test(code), "must use the shared helper");
    for (const re of s.mustNot) {
      check(`${s.f} does NOT hand-build a link [${re.source}]`, !re.test(code), "found a hand-built link/length");
    }
  }

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
