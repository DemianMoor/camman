// Per-NUMBER opt-out footer (migration 0141) — the most specific level of the
// chain, now editable.
//
// The column shipped with Q3 and had no UI: the chain had a hole in its top
// slot that nothing could fill. This proves the slot now works END TO END —
// stored value → resolver → rendered body → the operator-facing label — with
// the value SYNTHESIZED IN A ROLLED-BACK TRANSACTION so no live number is
// configured.
//
// Bars:
//   (0) The shipped state is REPORTED, not asserted. (A guard that asserts
//       "no number has one" expires the first time the feature is used.)
//   (1) A number-level value WINS over the account and the stage, and the
//       rendered body carries it verbatim.
//   (2) The winner is NAMED as the number — an operator editing a box whose
//       value will never ship is the failure this surfaces.
//   (3) Clearing it falls back to the account, and then to the stage. "" and
//       whitespace mean NO PREFERENCE, never an empty footer.
//   (4) The COMPLIANCE GATE validates the number-level winner: a number-level
//       footer with no STOP keyword must REFUSE the stage, even when the stage
//       and the account are both compliant.
//
// FAULT INJECTION proves each bar can fail.
import "./_env-preload";

import { promises as fs } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import { buildRepresentativeTrackedLinkUrl } from "@/lib/links/tracked-link";
import {
  DEFAULT_OPT_OUT_FOOTER,
  describeOptOutFooterLevel,
  optOutGateSubject,
  resolveOptOutFooter,
} from "@/lib/sends/opt-out-footer";
import { hasOptOutLanguage } from "@/lib/sends/segments";
import { buildStageSms } from "@/lib/sends/stage-sms";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}
const ROLLBACK = Symbol("rollback");

async function main() {
  // ── (0) SHIPPED STATE — reported, never asserted ─────────────────────────
  const live = (await db.execute(sql`
    SELECT pp.id, pp.phone_number, pp.opt_out_footer, p.sms_provider_id, p.opt_out_footer AS provider_footer
    FROM provider_phones pp
    LEFT JOIN sms_providers p ON p.id = pp.provider_id
    WHERE pp.opt_out_footer IS NOT NULL
    ORDER BY pp.id
  `)) as unknown as {
    id: number; phone_number: string; opt_out_footer: string;
    sms_provider_id: string | null; provider_footer: string | null;
  }[];
  console.log(`\nSHIPPED STATE — ${live.length} number(s) carry their own opt-out footer`);
  for (const r of live) {
    console.log(`     #${r.id} ${r.phone_number} (${r.sms_provider_id}): ${JSON.stringify(r.opt_out_footer)}`);
  }
  if (live.length === 0) console.log("     none — every number inherits (the shipped state)");
  // Durable instead: any value that IS set must be sendable. A number-level
  // footer without a STOP keyword refuses every stage on that number, so it
  // would be a silent outage rather than a configuration.
  const nonCompliant = live.filter((r) => !hasOptOutLanguage(r.opt_out_footer));
  check(
    "every number-level footer that EXISTS contains a STOP keyword",
    nonCompliant.length === 0,
    nonCompliant.map((r) => `#${r.id} ${JSON.stringify(r.opt_out_footer)}`).join(", ") ||
      `${live.length} checked`,
  );

  // ── (1)-(3) THE CHAIN, as pure resolution ────────────────────────────────
  const NUMBER = "Txt STOP to opt out";
  const ACCOUNT = "Reply STOP to quit";
  const STAGE = "Stop to END";
  console.log("\nCHAIN — number > account > stage > default:");
  const winner = resolveOptOutFooter({
    numberFooter: NUMBER, providerFooter: ACCOUNT, stageStopText: STAGE,
  });
  check(
    "(1) a number-level footer WINS over the account and the stage",
    winner.text === NUMBER && winner.level === "number",
    `text=${JSON.stringify(winner.text)} level=${winner.level}`,
  );
  check(
    "(2) the winning level is NAMED as the sending number",
    describeOptOutFooterLevel(winner.level) === "this sending number",
    `"${describeOptOutFooterLevel(winner.level)}"`,
  );
  for (const [label, value, expText, expLevel] of [
    ["cleared to null falls back to the account", null, ACCOUNT, "provider"],
    ['"" means NO PREFERENCE, not an empty footer', "", ACCOUNT, "provider"],
    ["whitespace-only means no preference too", "   ", ACCOUNT, "provider"],
  ] as [string, string | null, string, string][]) {
    const r = resolveOptOutFooter({
      numberFooter: value, providerFooter: ACCOUNT, stageStopText: STAGE,
    });
    check(`(3) ${label}`, r.text === expText && r.level === expLevel, `got ${JSON.stringify(r.text)} / ${r.level}`);
  }
  const noAccount = resolveOptOutFooter({ numberFooter: null, providerFooter: null, stageStopText: STAGE });
  check(
    "(3) with no number and no account, the stage's STOP text wins",
    noAccount.text === STAGE && noAccount.level === "stage",
    `got ${JSON.stringify(noAccount.text)} / ${noAccount.level}`,
  );
  const nothing = resolveOptOutFooter({});
  check(
    "(3) with nothing set at all, the system default wins",
    nothing.text === DEFAULT_OPT_OUT_FOOTER && nothing.level === "default",
    `got ${JSON.stringify(nothing.text)} / ${nothing.level}`,
  );

  // ── (1) THE RENDERED BODY carries it verbatim ────────────────────────────
  const link = buildRepresentativeTrackedLinkUrl("gdkn.org");
  const body = buildStageSms({
    brandName: "Guide Kin", creativeText: "hello", linkUrl: link, stopText: winner.text,
  });
  check(
    "(1) the rendered body ends with the NUMBER's text, not the account's or the stage's",
    body.endsWith(NUMBER) && !body.includes(ACCOUNT) && !body.includes(STAGE),
    JSON.stringify(body),
  );

  // ── (4) THE GATE VALIDATES THE NUMBER-LEVEL WINNER ───────────────────────
  // Both lower levels compliant, the winner not. The gate must refuse.
  const trapNumber = "No more texts";
  const trapResolved = resolveOptOutFooter({
    numberFooter: trapNumber, providerFooter: ACCOUNT, stageStopText: STAGE,
  });
  const trapBody = buildStageSms({
    brandName: "Guide Kin", creativeText: "hello", linkUrl: link, stopText: trapResolved.text,
  });
  const trapGate = optOutGateSubject({ renderedBody: trapBody, resolved: trapResolved });
  const trapPasses = trapGate.verifiable && hasOptOutLanguage(trapGate.subject);
  console.log(`\n(4) number=${JSON.stringify(trapNumber)} (NOT compliant, wins) over compliant account + stage`);
  check(
    "(4) a non-compliant NUMBER-level footer is REFUSED, even with compliant lower levels",
    trapPasses === false,
    trapPasses
      ? "GATE PASSED a body whose shipped opt-out wording has no STOP keyword"
      : "refused, as required",
  );
  const okResolved = resolveOptOutFooter({
    numberFooter: NUMBER, providerFooter: "no keyword here", stageStopText: "none either",
  });
  const okBody = buildStageSms({ brandName: "G", creativeText: "hi", linkUrl: link, stopText: okResolved.text });
  check(
    "(4) a compliant NUMBER-level footer satisfies the gate even when both lower levels do not",
    optOutGateSubject({ renderedBody: okBody, resolved: okResolved }).verifiable &&
      hasOptOutLanguage(optOutGateSubject({ renderedBody: okBody, resolved: okResolved }).subject),
    JSON.stringify(okBody),
  );

  // ── END TO END, through the DATABASE, rolled back ────────────────────────
  // Everything above is pure. This proves the STORED column reaches the
  // resolver with the same result — the step a unit test cannot cover.
  const target = (await db.execute(sql`
    SELECT pp.id, pp.phone_number, pp.opt_out_footer AS current_footer,
           p.opt_out_footer AS provider_footer, p.sms_provider_id
    FROM provider_phones pp
    LEFT JOIN sms_providers p ON p.id = pp.provider_id
    WHERE pp.status = 'active'
    -- PREFER a number whose ACCOUNT already carries a footer, so "the number
    -- out-ranks the account" is exercised against a real competing value. With
    -- an arbitrary number the account side is often NULL and the bar reduces to
    -- "a value beats nothing", which proves far less than it appears to.
    ORDER BY (p.opt_out_footer IS NOT NULL) DESC, pp.id
    LIMIT 1
  `)) as unknown as {
    id: number; phone_number: string; current_footer: string | null;
    provider_footer: string | null; sms_provider_id: string | null;
  }[];
  check("an active number exists to exercise", target.length > 0, target[0] ? `#${target[0].id}` : "none");
  if (!target[0]) {
    await pgConn.end({ timeout: 5 });
    process.exit(1);
  }
  const phoneId = target[0].id;
  console.log(
    `\nEND TO END on number #${phoneId} ${target[0].phone_number} ` +
      `(account ${target[0].sms_provider_id ?? "—"} footer=${JSON.stringify(target[0].provider_footer)})`,
  );

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE provider_phones SET opt_out_footer = ${NUMBER} WHERE id = ${phoneId}
      `);
      // Read it back the way the phones list delivers it to the stage form.
      const readBack = (await tx.execute(sql`
        SELECT pp.opt_out_footer AS number_footer, p.opt_out_footer AS provider_footer
        FROM provider_phones pp
        LEFT JOIN sms_providers p ON p.id = pp.provider_id
        WHERE pp.id = ${phoneId}
      `)) as unknown as { number_footer: string | null; provider_footer: string | null }[];
      check(
        "the STORED value survives the round trip",
        readBack[0].number_footer === NUMBER,
        JSON.stringify(readBack[0].number_footer),
      );
      const fromDb = resolveOptOutFooter({
        numberFooter: readBack[0].number_footer,
        providerFooter: readBack[0].provider_footer,
        stageStopText: STAGE,
      });
      check(
        "a SYNTHESIZED number-level value wins the chain against the REAL account footer",
        fromDb.text === NUMBER && fromDb.level === "number",
        `account=${JSON.stringify(readBack[0].provider_footer)} → winner=${JSON.stringify(fromDb.text)} (${fromDb.level})`,
      );
      // Non-vacuity: if the account side is NULL there was nothing to out-rank,
      // and the bar above proved only "a value beats nothing". Said out loud
      // rather than left for a reader to notice.
      check(
        "…and that account footer was NON-EMPTY, so something was really out-ranked",
        (readBack[0].provider_footer ?? "").trim().length > 0,
        readBack[0].provider_footer === null
          ? "account footer is NULL — no number in this org has an account-level footer to beat"
          : JSON.stringify(readBack[0].provider_footer),
      );
      check(
        "the body that would ship from this number carries it",
        buildStageSms({ brandName: "Guide Kin", creativeText: "hello", linkUrl: link, stopText: fromDb.text }).endsWith(NUMBER),
        "rendered from the stored value, not from the form",
      );

      // FAULT INJECTION: clearing it must hand the chain back.
      await tx.execute(sql`UPDATE provider_phones SET opt_out_footer = NULL WHERE id = ${phoneId}`);
      const cleared = (await tx.execute(sql`
        SELECT pp.opt_out_footer AS number_footer, p.opt_out_footer AS provider_footer
        FROM provider_phones pp LEFT JOIN sms_providers p ON p.id = pp.provider_id
        WHERE pp.id = ${phoneId}
      `)) as unknown as { number_footer: string | null; provider_footer: string | null }[];
      const after = resolveOptOutFooter({
        numberFooter: cleared[0].number_footer,
        providerFooter: cleared[0].provider_footer,
        stageStopText: STAGE,
      });
      check(
        "#1 clearing the column hands the chain back to the account/stage",
        after.level !== "number" && after.text !== NUMBER,
        `winner=${JSON.stringify(after.text)} (${after.level})`,
      );
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  // ── ROLLBACK VERIFIED BY RE-QUERY ────────────────────────────────────────
  const post = (await db.execute(sql`
    SELECT count(*)::int AS n FROM provider_phones WHERE opt_out_footer IS NOT NULL
  `)) as unknown as { n: number }[];
  check(
    "rollback left the number-level footers exactly as this run found them",
    post[0].n === live.length,
    `before=${live.length} after=${post[0].n}`,
  );
  const restored = (await db.execute(sql`
    SELECT opt_out_footer FROM provider_phones WHERE id = ${phoneId}
  `)) as unknown as { opt_out_footer: string | null }[];
  check(
    "the exercised number is back to its original value",
    (restored[0].opt_out_footer ?? null) === (target[0].current_footer ?? null),
    `${JSON.stringify(restored[0].opt_out_footer)} (was ${JSON.stringify(target[0].current_footer)})`,
  );

  // ── SOURCE: the field exists, saves, and hydrates ────────────────────────
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  console.log("\nSOURCE GUARD (comments stripped):");
  const form = strip(await fs.readFile(path.join(process.cwd(), "components/providers/phone-form.tsx"), "utf8"));
  check(
    "the phone form has an opt-out text field bound to the number's value",
    /optOutFooter/.test(form) && /Opt-out text/.test(form),
    "the 0141 column had no UI before this change",
  );
  check(
    "an empty box submits NULL, not an empty string",
    /optOutFooter\.trim\(\) === "" \? null/.test(form),
    'storing "" would read as set while behaving as unset',
  );
  const page = strip(await fs.readFile(path.join(process.cwd(), "app/(protected)/providers/[id]/page.tsx"), "utf8"));
  // Same silent-drop trap the Q4 fields hit: a hand-built patch literal that
  // omits a collected field returns 200 while the column never changes.
  check(
    "the phone PATCH payload carries opt_out_footer (silent-drop trap)",
    /opt_out_footer:\s*values\./.test(page),
    "must be listed explicitly in the hand-built patch object",
  );
  check(
    "the Edit dialog hydrates the field from the stored value",
    /initialOptOutFooter=\{editingPhone\.opt_out_footer\}/.test(page),
    "without this the box opens empty and Save would clear a real override",
  );
  // The stage form must NAME the number when it wins — that display is the
  // whole reason an operator can trust the box they are editing.
  const stageForm = strip(await fs.readFile(path.join(process.cwd(), "components/campaigns/stage-form.tsx"), "utf8"));
  check(
    "the stage form ranks the NUMBER's footer into its preview",
    /numberFooter:\s*selectedPhone\?\.opt_out_footer/.test(stageForm),
    "previewing the raw stage field would show a message that is not the one that ships",
  );
  check(
    "the stage form NAMES the winning level",
    /describeOptOutFooterLevel\(resolvedFooter\.level\)/.test(stageForm),
    'and describeOptOutFooterLevel("number") === "this sending number"',
  );

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
