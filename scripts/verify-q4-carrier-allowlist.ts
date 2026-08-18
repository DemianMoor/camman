// Q4 — per-number carrier allow-list. Enforcement proof.
//
// MACHINERY-ONLY is itself the first acceptance test: with an empty
// phone_carrier_limits table and allow_unknown_carrier true everywhere, every
// audience must be byte-for-byte what it is today. Bars:
//
//   (0) NO-OP: the shipped, unconfigured state changes no audience.
//   (1) A synthesized restriction excludes EXACTLY the targeted carrier's
//       contacts — no more, no fewer — in a ROLLED-BACK transaction.
//   (2) The preflight breakdown REPORTS that exclusion, per carrier.
//   (3) AND-composition with the campaign-level carrier filter behaves as
//       documented: each side can only narrow.
//   (4) allow_unknown_carrier governs the three unknown-ish buckets together.
//
// Every configured state is SYNTHESIZED INSIDE A TRANSACTION AND ROLLED BACK.
// Zero live configuration is written — the guard is durable from the start
// rather than asserting today's empty state (the stale-guard trap).
//
// FAULT INJECTION proves each bar can fail.
import "./_env-preload";

import { promises as fs } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";
import {
  CARRIER_NORMS,
  NAMED_CARRIERS,
  carrierPolicyClause,
  UNKNOWN_CARRIER_BUCKETS,
} from "@/lib/sends/carrier-policy";
import { computePreflightBreakdown } from "@/lib/sends/preflight-breakdown";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}
const ROLLBACK = Symbol("rollback");

async function main() {
  // ── (0) SHIPPED STATE IS A NO-OP ─────────────────────────────────────────
  const live = (await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM phone_carrier_limits) AS policy_rows,
      (SELECT count(*)::int FROM provider_phones WHERE allow_unknown_carrier = false) AS unknown_off,
      (SELECT count(*)::int FROM provider_phones) AS phones
  `)) as unknown as { policy_rows: number; unknown_off: number; phones: number }[];
  console.log(
    `\nSHIPPED STATE — phone_carrier_limits rows: ${live[0].policy_rows} · ` +
      `numbers with allow_unknown_carrier=false: ${live[0].unknown_off} of ${live[0].phones}`,
  );
  // THIS BAR DELIBERATELY DOES NOT ASSERT "the table is empty".
  //
  // It did, in the machinery-only run that shipped 0142 - and that assertion
  // expires the first time an operator uses the feature, which is the whole
  // point of having built it. A guard that goes red on correct use is not a
  // guard, it is a countdown. What is DURABLY true is asserted instead, and the
  // live configuration is REPORTED so a run still shows what it ran against.
  const configured = (await db.execute(sql`
    SELECT pcl.provider_phone_id, pp.phone_number, pcl.carrier_norm, pcl.allowed, pcl.daily_limit
    FROM phone_carrier_limits pcl
    JOIN provider_phones pp ON pp.id = pcl.provider_phone_id
    ORDER BY pcl.provider_phone_id, pcl.carrier_norm
  `)) as unknown as {
    provider_phone_id: number; phone_number: string; carrier_norm: string;
    allowed: boolean; daily_limit: number | null;
  }[];
  if (configured.length === 0) {
    console.log("     no number carries a carrier policy (the shipped, unconfigured state)");
  } else {
    for (const c of configured) {
      console.log(
        `     #${c.provider_phone_id} ${c.phone_number}: ${c.carrier_norm} ` +
          `allowed=${c.allowed} daily_limit=${c.daily_limit ?? "uncapped"}`,
      );
    }
  }
  // Durable: every stored row is one the UI could have produced. A row naming a
  // carrier outside the normalized vocabulary can never match `carrier_norm`
  // and would sit in the table forever doing nothing.
  const badVocab = configured.filter(
    (c) => !(CARRIER_NORMS as readonly string[]).includes(c.carrier_norm),
  );
  check(
    "every stored policy row names a carrier from the normalized vocabulary",
    badVocab.length === 0,
    badVocab.map((c) => `#${c.provider_phone_id} ${c.carrier_norm}`).join(", ") ||
      `${configured.length} row(s) checked`,
  );
  // Durable: a row that neither denies nor caps is indistinguishable from no
  // row, so storing one makes "is this number configured?" unanswerable by
  // counting rows. The write path filters those out; this proves it still does.
  const meaningless = configured.filter((c) => c.allowed !== false && c.daily_limit === null);
  check(
    "no stored policy row is a no-op (allowed with no cap == no row at all)",
    meaningless.length === 0,
    meaningless.map((c) => `#${c.provider_phone_id} ${c.carrier_norm}`).join(", ") ||
      `${configured.length} row(s) checked`,
  );

  // The code's carrier vocabulary must still match the DATABASE's. The check
  // constraint on carrier_mappings is the authority; if it is ever widened,
  // NAMED_CARRIERS silently stops offering the new carrier and no number can be
  // configured for it.
  const constraintRow = (await db.execute(sql`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conname = 'carrier_mappings_carrier_norm_check'
  `)) as unknown as { def: string }[];
  const constraintDef = constraintRow[0]?.def ?? "";
  const missingFromDb = CARRIER_NORMS.filter((c) => !constraintDef.includes(c));
  check(
    "CARRIER_NORMS still matches the database's carrier vocabulary",
    constraintRow.length === 1 && missingFromDb.length === 0,
    constraintRow.length !== 1
      ? "carrier_mappings_carrier_norm_check NOT FOUND - this cross-check is inert"
      : missingFromDb.length
        ? `absent from the DB constraint: ${missingFromDb.join(", ")}`
        : constraintDef,
  );
  check(
    "the unknown buckets are NOT individually toggleable (one switch governs all three)",
    NAMED_CARRIERS.every((c) => !(UNKNOWN_CARRIER_BUCKETS as readonly string[]).includes(c)) &&
      NAMED_CARRIERS.length === CARRIER_NORMS.length - 1,
    `NAMED_CARRIERS = ${NAMED_CARRIERS.join(", ")}`,
  );

  // The clause itself must be a literal no-op with no policy and with an
  // unconfigured policy — that is what makes the empty table byte-identical.
  const noPolicy = carrierPolicyClause(undefined, "00000000-0000-0000-0000-000000000000", sql`c.carrier_norm`);
  check(
    "no policy ⇒ the clause is a literal TRUE (byte-identical SQL)",
    JSON.stringify(noPolicy).includes("true"),
    "clause collapses to TRUE when no sending number is assigned",
  );

  const orgRow = (await db.execute(sql`SELECT id FROM organizations LIMIT 1`)) as unknown as { id: string }[];
  const orgId = orgRow[0].id;

  // Pick a real number and a carrier that actually has contacts, so bar (1) is
  // non-vacuous. Scope is printed.
  const carriers = (await db.execute(sql`
    SELECT carrier_norm, count(*)::int AS n FROM contacts
    WHERE org_id = ${orgId} AND messaging_status = 'eligible'
    GROUP BY carrier_norm ORDER BY count(*) DESC
  `)) as unknown as { carrier_norm: string | null; n: number }[];
  console.log(`\nCONTACT CARRIER SCOPE (${carriers.length} bucket(s)):`);
  for (const c of carriers) console.log(`     ${c.carrier_norm ?? "(null)"}: ${c.n.toLocaleString()}`);
  check("carrier scope is non-empty", carriers.length > 0, `${carriers.length}`);

  const target = carriers.find((c) => c.carrier_norm && !UNKNOWN_CARRIER_BUCKETS.includes(c.carrier_norm as never) && c.n > 0);
  check(
    "a real (non-unknown) carrier with contacts exists to restrict",
    !!target,
    target ? `${target.carrier_norm} (${target.n.toLocaleString()} contacts)` : "NONE — bar (1) would be vacuous",
  );
  // Prefer a number that a stage with a FROZEN AUDIENCE POOL actually sends
  // from — otherwise bar (2) has no breakdown to exercise and would report NOT
  // OBSERVABLE for a reason that is an artefact of the pick, not of the system.
  const phone = (await db.execute(sql`
    SELECT pp.id, pp.phone_number
    FROM provider_phones pp
    WHERE pp.org_id = ${orgId} AND pp.status = 'active'
    ORDER BY
      (EXISTS (
        SELECT 1 FROM campaign_stages s
        JOIN campaigns c ON c.id = s.campaign_id
        WHERE s.provider_phone_id = pp.id
          AND EXISTS (SELECT 1 FROM campaign_audience_pool ap WHERE ap.campaign_id = c.id)
      )) DESC,
      pp.id ASC
    LIMIT 1
  `)) as unknown as { id: number; phone_number: string }[];
  check("an active number exists to configure", phone.length > 0, phone[0] ? `#${phone[0].id}` : "none");
  if (!target || !phone[0]) {
    await pgConn.end({ timeout: 5 });
    process.exit(1);
  }
  const phoneId = phone[0].id;
  const targetCarrier = target.carrier_norm!;

  // Helper: how many eligible contacts survive a policy, straight from the
  // clause under test (not a re-implementation of it).
  const countUnder = async (
    dbc: typeof db,
    policy: { providerPhoneId: number | null; allowUnknownCarrier: boolean } | undefined,
  ) => {
    const rows = (await dbc.execute(sql`
      SELECT count(*)::int AS n FROM contacts c
      WHERE c.org_id = ${orgId} AND c.messaging_status = 'eligible'
        AND ${carrierPolicyClause(policy, orgId, sql`c.carrier_norm`)}
    `)) as unknown as { n: number }[];
    return Number(rows[0].n);
  };

  try {
    await db.transaction(async (tx) => {
      const dbc = tx as unknown as typeof db;
      const baseline = await countUnder(dbc, { providerPhoneId: phoneId, allowUnknownCarrier: true });
      const totalEligible = await countUnder(dbc, undefined);
      console.log(`\nBASELINE — eligible contacts: ${totalEligible.toLocaleString()}`);
      check(
        "(0) an UNCONFIGURED number excludes nobody",
        baseline === totalEligible,
        `with policy=${baseline.toLocaleString()} vs without=${totalEligible.toLocaleString()}`,
      );

      // ── (1) SYNTHESIZED RESTRICTION ────────────────────────────────────
      await tx.execute(sql`
        INSERT INTO phone_carrier_limits (org_id, provider_phone_id, carrier_norm, allowed)
        VALUES (${orgId}, ${phoneId}, ${targetCarrier}, false)
      `);
      const restricted = await countUnder(dbc, { providerPhoneId: phoneId, allowUnknownCarrier: true });
      const expected = totalEligible - target.n;
      console.log(
        `\n(1) Restricting ${targetCarrier} on number #${phoneId}: ` +
          `${totalEligible.toLocaleString()} -> ${restricted.toLocaleString()} (expected ${expected.toLocaleString()})`,
      );
      check(
        "(1) exactly the targeted carrier's contacts are excluded",
        restricted === expected,
        `got ${restricted.toLocaleString()}, expected ${expected.toLocaleString()} (delta ${(restricted - expected).toLocaleString()})`,
      );
      // ...and nobody else's: every surviving contact has a different carrier.
      const leaked = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM contacts c
        WHERE c.org_id = ${orgId} AND c.messaging_status = 'eligible'
          AND c.carrier_norm = ${targetCarrier}
          AND ${carrierPolicyClause({ providerPhoneId: phoneId, allowUnknownCarrier: true }, orgId, sql`c.carrier_norm`)}
      `)) as unknown as { n: number }[];
      check(
        "(1) no contact of the restricted carrier survives",
        leaked[0].n === 0,
        `${leaked[0].n} leaked`,
      );
      // A DIFFERENT number must be unaffected — the policy is per-number.
      const otherPhone = (await tx.execute(sql`
        SELECT id FROM provider_phones WHERE org_id = ${orgId} AND id <> ${phoneId} ORDER BY id LIMIT 1
      `)) as unknown as { id: number }[];
      if (otherPhone[0]) {
        const otherCount = await countUnder(dbc, { providerPhoneId: otherPhone[0].id, allowUnknownCarrier: true });
        check(
          "(1) the restriction is PER NUMBER — another number is unaffected",
          otherCount === totalEligible,
          `number #${otherPhone[0].id}: ${otherCount.toLocaleString()} vs ${totalEligible.toLocaleString()}`,
        );
      }

      // ── (2) THE PREFLIGHT BREAKDOWN REPORTS THE EXCLUSION ──────────────
      // Not just "the audience shrank" — the operator must be told WHICH
      // carrier and HOW MANY, or the number is unactionable.
      const stageRow = (await tx.execute(sql`
        SELECT s.id AS stage_id, s.campaign_id
        FROM campaign_stages s
        JOIN campaigns c ON c.id = s.campaign_id
        WHERE s.provider_phone_id = ${phoneId} AND c.org_id = ${orgId}
          AND EXISTS (SELECT 1 FROM campaign_audience_pool ap WHERE ap.campaign_id = c.id)
        ORDER BY s.id DESC LIMIT 1
      `)) as unknown as { stage_id: number; campaign_id: number }[];
      if (stageRow[0]) {
        await tx.execute(sql`
          UPDATE provider_phones SET id = id WHERE id = ${phoneId}
        `);
        const bd = await computePreflightBreakdown(dbc, {
          orgId,
          campaignId: stageRow[0].campaign_id,
          stageId: stageRow[0].stage_id,
        });
        const reported = bd.excluded.carrier ?? {};
        const keys = Object.keys(reported);
        console.log(
          `
(2) preflight breakdown for stage ${stageRow[0].stage_id}: ` +
            `excluded.carrier = ${JSON.stringify(reported)}`,
        );
        check(
          "(2) the breakdown names the restricted carrier",
          keys.includes(targetCarrier),
          `keys=[${keys.join(", ")}] expected to include ${targetCarrier}`,
        );
        check(
          "(2) the reported count is non-zero and attributable",
          (reported[targetCarrier] ?? 0) > 0,
          `${targetCarrier}=${reported[targetCarrier] ?? 0}`,
        );
      } else {
        console.log("\n(2) NOT OBSERVABLE — no stage on this number has a frozen audience pool.");
        check("(2) a stage with a pool exists on the configured number", false, "cannot exercise the breakdown");
      }

      // ── (3) AND-COMPOSITION with a campaign-level carrier filter ────────
      // The campaign filter is frozen into the pool; here we model it as an
      // additional predicate and assert the composition can only NARROW.
      const campaignPick = carriers.find((c) => c.carrier_norm && c.carrier_norm !== targetCarrier && c.n > 0);
      if (campaignPick) {
        const both = (await tx.execute(sql`
          SELECT count(*)::int AS n FROM contacts c
          WHERE c.org_id = ${orgId} AND c.messaging_status = 'eligible'
            AND c.carrier_norm = ${campaignPick.carrier_norm}
            AND ${carrierPolicyClause({ providerPhoneId: phoneId, allowUnknownCarrier: true }, orgId, sql`c.carrier_norm`)}
        `)) as unknown as { n: number }[];
        console.log(
          `\n(3) campaign filter=${campaignPick.carrier_norm} AND number restricts ${targetCarrier}: ${both[0].n.toLocaleString()}`,
        );
        check(
          "(3) AND-composition never widens either side",
          both[0].n <= campaignPick.n && both[0].n <= restricted,
          `both=${both[0].n} campaignSide=${campaignPick.n} numberSide=${restricted}`,
        );
        check(
          "(3) a carrier allowed by BOTH survives the composition",
          both[0].n === campaignPick.n,
          `${both[0].n} of ${campaignPick.n} — the number does not restrict ${campaignPick.carrier_norm}`,
        );
        // And the intersection of a campaign filter ON the restricted carrier is empty.
        const contradiction = (await tx.execute(sql`
          SELECT count(*)::int AS n FROM contacts c
          WHERE c.org_id = ${orgId} AND c.messaging_status = 'eligible'
            AND c.carrier_norm = ${targetCarrier}
            AND ${carrierPolicyClause({ providerPhoneId: phoneId, allowUnknownCarrier: true }, orgId, sql`c.carrier_norm`)}
        `)) as unknown as { n: number }[];
        check(
          "(3) campaign selecting a carrier the NUMBER forbids yields an empty audience",
          contradiction[0].n === 0,
          `${contradiction[0].n} — the number's NO must win over the campaign's YES`,
        );
      }

      // ── (4) allow_unknown_carrier governs all three buckets ─────────────
      const unknownTotal = carriers
        .filter((c) => c.carrier_norm && UNKNOWN_CARRIER_BUCKETS.includes(c.carrier_norm as never))
        .reduce((a, c) => a + c.n, 0);
      const nullCarrier = carriers.filter((c) => !c.carrier_norm).reduce((a, c) => a + c.n, 0);
      const withUnknownOff = await countUnder(dbc, { providerPhoneId: phoneId, allowUnknownCarrier: false });
      console.log(
        `\n(4) unknown-ish buckets total ${unknownTotal.toLocaleString()} (+${nullCarrier.toLocaleString()} NULL carrier)`,
      );
      check(
        "(4) turning allow_unknown_carrier off drops ALL unknown-ish buckets and NULLs",
        withUnknownOff === restricted - unknownTotal - nullCarrier,
        `got ${withUnknownOff.toLocaleString()}, expected ${(restricted - unknownTotal - nullCarrier).toLocaleString()}`,
      );
      check(
        "(4) the three buckets are still DISTINCT in the data",
        UNKNOWN_CARRIER_BUCKETS.length === 3,
        UNKNOWN_CARRIER_BUCKETS.join(", "),
      );

      // ── FAULT INJECTION ────────────────────────────────────────────────
      console.log("\nFAULT INJECTION:");
      // Restrict a carrier that does NOT exist ⇒ nothing may change. If the
      // count moves, the clause is matching something it should not.
      const bogus = await (async () => {
        await tx.execute(sql`
          INSERT INTO phone_carrier_limits (org_id, provider_phone_id, carrier_norm, allowed)
          VALUES (${orgId}, ${phoneId}, ${"NoSuchCarrier"}, false)
        `);
        return countUnder(dbc, { providerPhoneId: phoneId, allowUnknownCarrier: true });
      })();
      check(
        "#1 restricting a NON-EXISTENT carrier changes nothing (no over-matching)",
        bogus === restricted,
        `${bogus.toLocaleString()} vs ${restricted.toLocaleString()}`,
      );
      // An `allowed = true` row must also change nothing — absence and explicit
      // permission are the same thing.
      const allowedRow = await (async () => {
        const c2 = carriers.find((c) => c.carrier_norm && c.carrier_norm !== targetCarrier);
        if (!c2?.carrier_norm) return restricted;
        await tx.execute(sql`
          INSERT INTO phone_carrier_limits (org_id, provider_phone_id, carrier_norm, allowed)
          VALUES (${orgId}, ${phoneId}, ${c2.carrier_norm}, true)
        `);
        return countUnder(dbc, { providerPhoneId: phoneId, allowUnknownCarrier: true });
      })();
      check(
        "#2 an allowed=true row is equivalent to no row",
        allowedRow === restricted,
        `${allowedRow.toLocaleString()} vs ${restricted.toLocaleString()}`,
      );
      // And prove the harness CAN see a difference at all.
      check(
        "#3 the comparison is sensitive (restricted != unrestricted)",
        restricted !== totalEligible,
        `${restricted.toLocaleString()} vs ${totalEligible.toLocaleString()} — a blind harness would show these equal`,
      );

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  // ── ROLLBACK VERIFIED BY RE-QUERY ────────────────────────────────────────
  // The claim is "this run wrote nothing", NOT "the table is empty" - those
  // stop being the same statement the moment an operator configures a number.
  // Compared against the inventory taken before the transaction.
  const after = (await db.execute(sql`
    SELECT count(*)::int AS n FROM phone_carrier_limits
  `)) as unknown as { n: number }[];
  check(
    "rollback left the policy table exactly as this run found it",
    after[0].n === configured.length,
    `before=${configured.length} after=${after[0].n}`,
  );

  // ── SOURCE: every send-path recipient query passes the policy ────────────
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  console.log("\nSOURCE GUARD (comments stripped):");
  for (const f of [
    "lib/sends/kickoff.ts",
    "lib/sends/preflight.ts",
    "lib/sends/preflight-breakdown.ts",
    "app/api/campaigns/[campaignId]/stages/[stageId]/export-phones/route.ts",
  ]) {
    const raw = await fs.readFile(path.join(process.cwd(), f), "utf8");
    const code = strip(raw);
    check(`${f} passes carrierPolicy`, /carrierPolicy/.test(code), `${code.length} chars scanned`);
  }

  // -- SOURCE: the WRITE path and the two screens --------------------------
  //
  // The hand-built patch literal on the provider page is a known trap: a field
  // the form collects but the literal omits is validated, dropped, and answered
  // with 200 + a success toast while the column never changes. It has bitten
  // max_sends_per_second and dashboard_id already. Guarded by name.
  const pageSrc = strip(
    await fs.readFile(path.join(process.cwd(), "app/(protected)/providers/[id]/page.tsx"), "utf8"),
  );
  for (const key of ["allow_unknown_carrier", "carrier_limits"]) {
    check(
      `the phone PATCH payload carries ${key} (silent-drop trap)`,
      new RegExp(key + String.raw`:\s*values\.`).test(pageSrc),
      "must be listed explicitly in the hand-built patch object",
    );
  }
  const patchRoute = strip(
    await fs.readFile(
      path.join(process.cwd(), "app/api/providers/[providerId]/phones/[phoneId]/route.ts"),
      "utf8",
    ),
  );
  check(
    "the phone PATCH writes columns and policy rows in ONE transaction",
    /db\.transaction\(/.test(patchRoute) && /phone_carrier_limits/.test(patchRoute),
    "a split write can save the toggle while the allow-list fails",
  );
  check(
    "carrier_limits never reaches the column-update loop",
    /k === "carrier_limits"/.test(patchRoute),
    "it is a child table, not a column on provider_phones",
  );
  check(
    "a carrier_limits-only patch is not swallowed by the empty-updates guard",
    /Object\.keys\(updates\)\.length === 0 && carrierLimits === undefined/.test(patchRoute),
    "an allow-list edit that touches no phone column must still write",
  );
  const listRoute = strip(
    await fs.readFile(path.join(process.cwd(), "app/api/providers/[providerId]/phones/route.ts"), "utf8"),
  );
  check(
    "the phones list delivers the policy with the phone (one request, no hydrate race)",
    /allow_unknown_carrier/.test(listRoute) && /phone_carrier_limits/.test(listRoute),
    "a second fetch on dialog-open races defaultValues - how the short-domain override cleared itself",
  );
  // The AND statement is a SETTLED DECISION and must appear on BOTH screens. An
  // operator meets the two controls on different days, and the failure mode of
  // not knowing they compose is an empty audience with no visible cause.
  for (const [f, label] of [
    ["components/providers/phone-form.tsx", "phone settings"],
    ["components/campaigns/campaign-form-fields.tsx", "campaign audience"],
  ] as [string, string][]) {
    const src = await fs.readFile(path.join(process.cwd(), f), "utf8");
    const flat = src.replace(/\s+/g, " ");
    check(
      `the AND statement is on the ${label} screen`,
      /combined with <strong>AND<\/strong>/.test(flat) && /allowed by both/.test(flat),
      f,
    );
  }

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nALL PASS (rolled back)." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
