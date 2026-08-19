// One-shot cleanup of the `Stage Test *` fixture cluster left in PRODUCTION by
// interrupted runs of scripts/test-campaign-stages-api.ts, plus the inert
// `tls-t` provider row.
//
// DRY RUN BY DEFAULT. Pass --apply to actually delete.
//
//   npx tsx scripts/cleanup-stage-test-fixtures.ts            # report only
//   npx tsx scripts/cleanup-stage-test-fixtures.ts --apply    # delete
//
// ── WHY THE IDS ARE HARDCODED ───────────────────────────────────────────────
//
// Every delete names EXPLICIT IDS resolved and reviewed on 2026-08-19. It would
// be shorter to delete by pattern (`offer_id LIKE 'STG-O-%'`), and that is
// exactly what must not happen: a pattern re-evaluated later can match rows
// nobody reviewed. The audit that produced this list already caught one such
// near-miss — the fixture script mints contacts as `+15107<unique><nn>`, and
// `phone_number LIKE '+15107%'` matches 451 REAL contacts in area code 510
// (Oakland), 400 of which have genuinely sent messages. A pattern-based
// cleanup would have destroyed live customer data.
//
// ── WHY EACH ROW IS SIGNATURE-CHECKED FIRST ─────────────────────────────────
//
// Hardcoded ids are only safe while they still denote what was reviewed. Ids
// get recycled and rows get renamed, so before deleting anything this script
// re-reads every target and refuses unless it still matches the fixture
// signature it was approved under. A mismatch aborts the whole run.
//
// The check is "everything that STILL EXISTS matches", not "everything exists".
// A cleanup must be RE-RUNNABLE: the first run deleted nine of ten row types and
// left the contacts behind, and a pre-flight demanding the full set would then
// have refused to finish its own job. An already-deleted row is success.
import "./_env-preload";

import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";

const APPLY = process.argv.includes("--apply");

// ── THE APPROVED SET, resolved 2026-08-19 ───────────────────────────────────
const BRAND_IDS = [379];
const NETWORK_IDS = [31, 32, 33, 37];
const OFFER_IDS = [105, 106, 107, 111];
const SEGMENT_IDS = [212, 213, 214, 218];
const GROUP_IDS = [105, 106, 107, 111]; // contact_groups — same numbers as offers, different table
const CREATIVE_IDS = [548, 549, 550, 551, 552, 553, 558, 559];
const CONTACT_IDS = [
  "26b310e4-25c7-465a-83bf-0b6b442b9bcc",
  "6b84d63d-0e15-4bb2-890a-6bc22631ca25",
  "70579dfc-a0b5-4e9f-9ca3-5b3a37f2a101",
  "7136cf50-8974-4666-8531-51eab9e103f7",
  "79b177db-b9a9-45a6-9c12-4b463a618388",
  "7ebdec3e-8a34-44fb-8f36-97cca06eea97",
  "f18e9694-23c3-41a5-867f-d39e8b2a9b81",
  "f2326395-c621-44d9-abf2-ae7ff97ce151",
  "f77b2e04-ee8a-4ba2-9ea7-495f8dc8d435",
  "fc3d3805-bed2-4b60-9d34-a3e32c122553",
];
const PROVIDER_ID = 948; // 'tls-t' — archived, 0 phones/creds/stages/sends

// ID LISTS ARE RENDERED, NOT BOUND - and validated before rendering.
//
// Passing a JS array to a SQL array-membership test does NOT work here.
// Drizzle's sql template flattens the array into positional params, so a
// one-element list arrives as a scalar and postgres-js throws
// ERR_INVALID_ARG_TYPE; adding a ::int[] cast does not help, because the shape
// is already wrong by then. This repo has already lost a cleanup to exactly
// that class of failure: the delete threw, the surrounding block swallowed the
// error, and a probe row survived in production while the run reported success.
//
// So the lists are RENDERED into the SQL - acceptable only because every value
// is a hardcoded constant in this file AND is re-validated here. The validators
// THROW rather than skip: a malformed id must abort the run, never quietly
// shrink the delete set.
function intList(ids: number[]) {
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) throw new Error(`refusing to render non-positive-integer id: ${id}`);
  }
  if (ids.length === 0) throw new Error("refusing to render an empty id list");
  return sql.raw(ids.join(", "));
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidList(ids: string[]) {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`refusing to render non-uuid id: ${JSON.stringify(id)}`);
  }
  if (ids.length === 0) throw new Error("refusing to render an empty id list");
  return sql.raw(ids.map((id) => `'${id}'::uuid`).join(", "));
}

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `\n     ${detail}` : ""}`);
}

async function main() {
  console.log(
    APPLY
      ? "\n*** APPLY MODE — rows WILL be deleted ***"
      : "\n--- DRY RUN (pass --apply to delete) ---",
  );

  // ── PRE-FLIGHT: every target must still match its fixture signature ──────
  console.log("\nPRE-FLIGHT — do the approved ids still denote the reviewed rows?");

  const brands = (await db.execute(sql`
    SELECT id, name FROM brands WHERE id IN (${intList(BRAND_IDS)})
  `)) as unknown as { id: number; name: string }[];
  check(
    `brand ${BRAND_IDS.join(",")} is still "Stage Test Brand"`,
    brands.every((b) => b.name === "Stage Test Brand"),
    brands.map((b) => `#${b.id} ${JSON.stringify(b.name)}`).join(", ") || "already gone",
  );

  const nets = (await db.execute(sql`
    SELECT id, network_id FROM affiliate_networks WHERE id IN (${intList(NETWORK_IDS)})
  `)) as unknown as { id: number; network_id: string }[];
  check(
    "every target network still carries an STG-N- id",
    nets.every((n) => n.network_id.startsWith("STG-N-")),
    nets.map((n) => `#${n.id} ${n.network_id}`).join(", ") || "already gone",
  );

  const offers = (await db.execute(sql`
    SELECT id, offer_id FROM offers WHERE id IN (${intList(OFFER_IDS)})
  `)) as unknown as { id: number; offer_id: string }[];
  check(
    "every target offer still carries an STG-O- id",
    offers.every((o) => o.offer_id.startsWith("STG-O-")),
    offers.map((o) => `#${o.id} ${o.offer_id}`).join(", ") || "already gone",
  );

  const segs = (await db.execute(sql`
    SELECT id, segment_id FROM segments WHERE id IN (${intList(SEGMENT_IDS)})
  `)) as unknown as { id: number; segment_id: string }[];
  check(
    "every target segment still carries an STG-S- id",
    segs.every((s) => s.segment_id.startsWith("STG-S-")),
    segs.map((s) => `#${s.id} ${s.segment_id}`).join(", ") || "already gone",
  );

  const groups = (await db.execute(sql`
    SELECT id, contact_group_id FROM contact_groups WHERE id IN (${intList(GROUP_IDS)})
  `)) as unknown as { id: number; contact_group_id: string }[];
  check(
    "every target contact group still carries an STG-G- id",
    groups.every((g) => g.contact_group_id.startsWith("STG-G-")),
    groups.map((g) => `#${g.id} ${g.contact_group_id}`).join(", ") || "already gone",
  );

  const cres = (await db.execute(sql`
    SELECT id, text FROM creatives WHERE id IN (${intList(CREATIVE_IDS)})
  `)) as unknown as { id: number; text: string }[];
  check(
    "every target creative still starts with 'Stage test SMS body'",
    cres.every((c) => c.text.startsWith("Stage test SMS body")),
    `${cres.length} of ${CREATIVE_IDS.length} still present, all matching`,
  );

  const cts = (await db.execute(sql`
    SELECT id::text AS id, phone_number FROM contacts WHERE id IN (${uuidList(CONTACT_IDS)})
  `)) as unknown as { id: string; phone_number: string }[];
  check(
    "every target contact is still in the +1212555xxxx fixture block",
    cts.every((c) => c.phone_number.startsWith("+1212555")),
    `${cts.length} of ${CONTACT_IDS.length} still present, all matching`,
  );

  // ⚠️ THE ONE THAT MATTERS MOST: a contact that has ever been messaged is a
  // real person, whatever its number looks like. Refuse outright.
  const messaged = (await db.execute(sql`
    SELECT count(*)::int AS n FROM stage_sends WHERE contact_id IN (${uuidList(CONTACT_IDS)})
  `)) as unknown as { n: number }[];
  check(
    "NO target contact has ever had a stage_sends row (not even a skipped one)",
    messaged[0].n === 0,
    `${messaged[0].n} send row(s) — a contact that was ever messaged is not a fixture`,
  );

  const prov = (await db.execute(sql`
    SELECT id, sms_provider_id, status, supports_api_send,
      (SELECT count(*) FROM provider_phones ph WHERE ph.provider_id = ${PROVIDER_ID}) AS phones,
      (SELECT count(*) FROM provider_credentials pc WHERE pc.provider_id = ${PROVIDER_ID}) AS creds,
      (SELECT count(*) FROM campaign_stages s WHERE s.sms_provider_id = ${PROVIDER_ID}) AS stages,
      (SELECT count(*) FROM opt_out_providers o WHERE o.provider_id = ${PROVIDER_ID}) AS optouts,
      (SELECT count(*) FROM send_circuit_events e WHERE e.provider_id = ${PROVIDER_ID}) AS circuit_events
    FROM sms_providers WHERE id = ${PROVIDER_ID}
  `)) as unknown as {
    id: number; sms_provider_id: string; status: string; supports_api_send: boolean;
    phones: number; creds: number; stages: number; optouts: number; circuit_events: number;
  }[];
  check(
    `provider #${PROVIDER_ID} is still 'tls-t'`,
    prov.length === 0 || prov[0].sms_provider_id === "tls-t",
    prov[0] ? `${prov[0].sms_provider_id} (${prov[0].status})` : "already gone",
  );
  // Its FKs CASCADE — including opt_out_providers, which is compliance data.
  // Deleting it must therefore cascade to NOTHING, and that is proven, not assumed.
  check(
    "deleting it cascades to NOTHING (phones/creds/stages/opt-outs/circuit events all 0)",
    prov.length === 0 ||
      (Number(prov[0].phones) === 0 && Number(prov[0].creds) === 0 &&
        Number(prov[0].stages) === 0 && Number(prov[0].optouts) === 0 &&
        Number(prov[0].circuit_events) === 0),
    prov[0]
      ? `phones=${prov[0].phones} creds=${prov[0].creds} stages=${prov[0].stages} opt_outs=${prov[0].optouts} circuit_events=${prov[0].circuit_events}`
      : "n/a",
  );

  // Nothing real may reference the fixture cluster.
  const refs = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM campaigns WHERE brand_id IN (${intList(BRAND_IDS)}) OR offer_id IN (${intList(OFFER_IDS)}))::int AS campaigns,
      (SELECT count(*) FROM campaign_stages WHERE creative_id IN (${intList(CREATIVE_IDS)}))::int AS stages,
      (SELECT count(*) FROM provider_phones WHERE brand_id IN (${intList(BRAND_IDS)}))::int AS phones,
      (SELECT count(*) FROM short_domains WHERE brand_id IN (${intList(BRAND_IDS)}))::int AS domains,
      (SELECT count(*) FROM offer_exposures WHERE offer_id IN (${intList(OFFER_IDS)}))::int AS exposures,
      (SELECT count(*) FROM segment_contacts sc JOIN contacts c ON c.id = sc.contact_id
        WHERE sc.segment_id IN (${intList(SEGMENT_IDS)}) AND NOT (c.id IN (${uuidList(CONTACT_IDS)})))::int AS foreign_members
  `)) as unknown as {
    campaigns: number; stages: number; phones: number; domains: number; exposures: number; foreign_members: number;
  }[];
  const r = refs[0];
  check(
    "nothing real references the fixture cluster",
    r.campaigns === 0 && r.stages === 0 && r.phones === 0 && r.domains === 0 &&
      r.exposures === 0 && r.foreign_members === 0,
    `campaigns=${r.campaigns} stages=${r.stages} phones=${r.phones} domains=${r.domains} ` +
      `offer_exposures=${r.exposures} non-fixture segment members=${r.foreign_members}`,
  );

  if (failed > 0) {
    console.log(`\n${failed} PRE-FLIGHT CHECK(S) FAILED — deleting nothing.`);
    await pgConn.end({ timeout: 5 });
    process.exit(1);
  }
  console.log("\nPre-flight clean: every id still denotes the row it was approved as.");

  if (!APPLY) {
    console.log(
      "\nDRY RUN — would delete:\n" +
        `     segment_contacts for ${SEGMENT_IDS.length} segments\n` +
        `     contacts            ${CONTACT_IDS.length}\n` +
        `     segments            ${SEGMENT_IDS.join(", ")}\n` +
        `     contact_groups      ${GROUP_IDS.join(", ")}\n` +
        `     creative_offers for ${CREATIVE_IDS.length} creatives\n` +
        `     creatives           ${CREATIVE_IDS.join(", ")}\n` +
        `     offers              ${OFFER_IDS.join(", ")}\n` +
        `     affiliate_networks  ${NETWORK_IDS.join(", ")}\n` +
        `     brands              ${BRAND_IDS.join(", ")}\n` +
        `     sms_providers       ${PROVIDER_ID} (tls-t)\n` +
        "\nRe-run with --apply to execute.",
    );
    await pgConn.end({ timeout: 5 });
    return;
  }

  // ── DELETE, in dependency order, each step independent ───────────────────
  //
  // Per-step isolation: a teardown that stops at its first failure leaks
  // silently, because the crash surfaces after the earlier steps have printed.
  console.log("\nDELETING:");
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      console.log(`  ✓ ${label}`);
    } catch (e) {
      failed++;
      // FULL message, not the first line: the first run of this script lost the
      // reason a delete failed to truncation, and "10 survived" with no cause is
      // the least useful possible output from a cleanup.
      console.log(`  ✗ ${label} FAILED: ${(e as Error).message}`);
    }
  };

  await step("segment_contacts (fixture segments)", () =>
    db.execute(sql`DELETE FROM segment_contacts WHERE segment_id IN (${intList(SEGMENT_IDS)})`));
  await step("contact_contact_groups (fixture contacts)", () =>
    db.execute(sql`DELETE FROM contact_contact_groups WHERE contact_id IN (${uuidList(CONTACT_IDS)})`));
  await step("contacts (+1212555xxxx)", () =>
    db.execute(sql`DELETE FROM contacts WHERE id IN (${uuidList(CONTACT_IDS)})`));
  await step("segments (STG-S-)", () =>
    db.execute(sql`DELETE FROM segments WHERE id IN (${intList(SEGMENT_IDS)})`));
  await step("contact_groups (STG-G-)", () =>
    db.execute(sql`DELETE FROM contact_groups WHERE id IN (${intList(GROUP_IDS)})`));
  await step("creative_offers (fixture creatives)", () =>
    db.execute(sql`DELETE FROM creative_offers WHERE creative_id IN (${intList(CREATIVE_IDS)})`));
  await step("creatives (Stage test SMS body)", () =>
    db.execute(sql`DELETE FROM creatives WHERE id IN (${intList(CREATIVE_IDS)})`));
  await step("offers (STG-O-)", () =>
    db.execute(sql`DELETE FROM offers WHERE id IN (${intList(OFFER_IDS)})`));
  await step("affiliate_networks (STG-N-)", () =>
    db.execute(sql`DELETE FROM affiliate_networks WHERE id IN (${intList(NETWORK_IDS)})`));
  await step("brands (Stage Test Brand)", () =>
    db.execute(sql`DELETE FROM brands WHERE id IN (${intList(BRAND_IDS)})`));
  await step("sms_providers (tls-t)", () =>
    db.execute(sql`DELETE FROM sms_providers WHERE id = ${PROVIDER_ID}`));

  // ── RESIDUE VERIFICATION — re-query EVERY type ──────────────────────────
  // "Cleanup complete" is a claim; this is the check. It enumerates all types
  // rather than a sample, because the leak this exists to catch was precisely
  // a type nobody thought to look at.
  console.log("\nRESIDUE VERIFICATION:");
  const residue = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM brands WHERE id IN (${intList(BRAND_IDS)}))::int AS brands,
      (SELECT count(*) FROM affiliate_networks WHERE id IN (${intList(NETWORK_IDS)}))::int AS networks,
      (SELECT count(*) FROM offers WHERE id IN (${intList(OFFER_IDS)}))::int AS offers,
      (SELECT count(*) FROM segments WHERE id IN (${intList(SEGMENT_IDS)}))::int AS segments,
      (SELECT count(*) FROM contact_groups WHERE id IN (${intList(GROUP_IDS)}))::int AS groups,
      (SELECT count(*) FROM creatives WHERE id IN (${intList(CREATIVE_IDS)}))::int AS creatives,
      (SELECT count(*) FROM creative_offers WHERE creative_id IN (${intList(CREATIVE_IDS)}))::int AS creative_offers,
      (SELECT count(*) FROM contacts WHERE id IN (${uuidList(CONTACT_IDS)}))::int AS contacts,
      (SELECT count(*) FROM segment_contacts WHERE segment_id IN (${intList(SEGMENT_IDS)}))::int AS segment_contacts,
      (SELECT count(*) FROM sms_providers WHERE id = ${PROVIDER_ID})::int AS providers
  `)) as unknown as Record<string, number>[];
  for (const [k, v] of Object.entries(residue[0])) {
    check(`  ${k}: 0 remaining`, Number(v) === 0, `${v} survived`);
  }

  // And the real data that must be UNTOUCHED — asserted, not assumed.
  const untouched = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM contacts WHERE phone_number LIKE '+15107%')::int AS area_510_contacts,
      (SELECT count(*) FROM sms_providers)::int AS providers_left,
      (SELECT count(*) FROM brands)::int AS brands_left
  `)) as unknown as { area_510_contacts: number; providers_left: number; brands_left: number }[];
  check(
    "the 451 real +1510 contacts are UNTOUCHED (the near-miss this cleanup avoided)",
    untouched[0].area_510_contacts === 451,
    `${untouched[0].area_510_contacts} (expected 451)`,
  );
  console.log(
    `     providers remaining: ${untouched[0].providers_left} · brands remaining: ${untouched[0].brands_left}`,
  );

  await pgConn.end({ timeout: 5 });
  console.log(failed === 0 ? "\nCLEANUP COMPLETE — residue verified across all types." : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
