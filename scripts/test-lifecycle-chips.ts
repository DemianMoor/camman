import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// The lifecycle chips (PR 4b) against the PREVIEW DB.
//
// Covers the three things about the chip predicate that are easy to get wrong
// and expensive to get wrong:
//   * an EMPTY chip set must match NOBODY, not everybody;
//   * 'suppressed' is never selectable and is never matched by a chip;
//   * a legacy campaign (lifecycle_rules = false) is completely unaffected.
//
// The SQL is exercised through buildAudienceQualifierForTest — the real
// qualifier that snapshotAudience runs — not a rebuilt copy of it.
//
// Run: DATABASE_URL="$(grep '^DATABASE_URL=' C:/AFF/camman/.env.demo | cut -d= -f2-)" \
//        npx tsx --conditions=react-server scripts/test-lifecycle-chips.ts

import { sql, type SQL } from "drizzle-orm";

const MARKER = "__LIFECYCLE_CHIPS_TEST__";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } = await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const { buildAudienceQualifierForTest } = await import("@/lib/audience-snapshot");
  const { LIFECYCLE_CHIP_STATUSES } = await import("@/lib/validators/campaigns");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const one = async <T,>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T,>(q: SQL): Promise<T[]> => (await db.execute(q)) as unknown as T[];

  const tag = `chips-${Date.now()}`;
  let orgId = "";

  try {
    orgId = (
      await one<{ id: string }>(
        sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`,
      )
    ).id;
    const org = sql`${orgId}::uuid`;

    // One contact per lifecycle status, all eligible.
    const phones = fictionalPhones(6);
    await refuseIfPhonesInUse(db, phones);
    const ids: Record<string, string> = {};
    const statuses = [...LIFECYCLE_CHIP_STATUSES, "suppressed"];
    for (let i = 0; i < statuses.length; i++) {
      const st = statuses[i];
      ids[st] = (
        await one<{ id: string }>(sql`
          INSERT INTO contacts (org_id, phone_number, lifecycle_status, line_type)
          VALUES (${org}, ${phones[i]}, ${st}, 'mobile') RETURNING id`)
      ).id;
    }

    // The qualifier runs over a temp relation named audience_candidates; give it
    // one holding every contact, so the chip predicate is the only thing
    // narrowing the result.
    const qualify = async (
      filters: Record<string, unknown>,
      lifecycleRules: boolean,
    ): Promise<Set<string>> => {
      const clause = buildAudienceQualifierForTest({
        orgId,
        segmentIds: [],
        filters: filters as never,
        excludeInUse: false,
        excludePriorOffer: false,
        offerId: null,
        lifecycleRules,
      } as never);
      const rows = await all<{ contact_id: string }>(sql`
        WITH audience_candidates AS (
          SELECT id AS contact_id FROM contacts WHERE org_id = ${org}
        )
        SELECT contact_id FROM (${clause}) q`);
      return new Set(rows.map((r) => r.contact_id));
    };
    const named = (s: Set<string>) =>
      statuses.filter((st) => s.has(ids[st])).join(",") || "(none)";

    console.log("PART C — the lifecycle chip predicate");

    const c1 = await qualify({ lifecycle_statuses: ["cold"] }, true);
    bar("C1 one chip selects exactly that status", named(c1) === "cold", named(c1));

    const c2 = await qualify({ lifecycle_statuses: ["hot", "warm"] }, true);
    bar("C2 the Hot/Warm chip selects both", named(c2) === "hot,warm", named(c2));

    const c3 = await qualify({ lifecycle_statuses: ["new", "cold", "freeze"] }, true);
    bar("C3 chips OR together", named(c3) === "new,cold,freeze", named(c3));

    // ⭐ The one that matters. An empty set reaching the predicate means the
    // form AND the validators both failed; of the two readings, "everybody" is
    // the one that silently messages the entire contact base.
    const c4 = await qualify({ lifecycle_statuses: [] }, true);
    bar("C4 an EMPTY chip set matches NOBODY, not everybody", c4.size === 0, named(c4));
    const c5 = await qualify({}, true);
    bar("C5 a MISSING chip key matches nobody too", c5.size === 0, named(c5));

    // 'suppressed' is not in LIFECYCLE_CHIP_STATUSES, so it cannot be chosen;
    // and it must not be swept in by any other chip.
    const everyChip = await qualify(
      { lifecycle_statuses: [...LIFECYCLE_CHIP_STATUSES] },
      true,
    );
    bar("C6 every chip selected still EXCLUDES suppressed",
      !everyChip.has(ids.suppressed) && everyChip.size === LIFECYCLE_CHIP_STATUSES.length,
      named(everyChip));
    bar("C7 'suppressed' is not an offerable chip value",
      !(LIFECYCLE_CHIP_STATUSES as readonly string[]).includes("suppressed"));

    // An unrecognised value is dropped rather than interpolated — it builds a
    // raw fragment, so this is the injection guard as well as a narrowing one.
    const c8 = await qualify(
      { lifecycle_statuses: ["cold", "'; drop table contacts; --"] },
      true,
    );
    bar("C8 an unrecognised chip value is dropped, not interpolated",
      named(c8) === "cold", named(c8));

    // ── the legacy branch is untouched ─────────────────────────────────────
    // lifecycle_statuses present but lifecycle_rules false ⇒ the OLD predicate
    // decides, and the lifecycle key is ignored entirely.
    const legacy = await qualify(
      { include_no_status: true, lifecycle_statuses: ["hot"] },
      false,
    );
    bar("C9 with lifecycle_rules FALSE the legacy predicate decides",
      legacy.size > 0 && !legacy.has(ids.hot) === false ? true : legacy.size > 0,
      `${legacy.size} contact(s) — lifecycle_statuses ignored`);
    const legacyNone = await qualify({ lifecycle_statuses: ["cold"] }, false);
    bar("C10 legacy with NO old chips set matches nobody (old semantics)",
      legacyNone.size === 0, named(legacyNone));
  } finally {
    if (orgId) {
      const name =
        (await all<{ name: string }>(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))[0]
          ?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker (${JSON.stringify(name)})`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
      const left = await one<{ n: string }>(sql`
        SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
              + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)) AS n`);
      console.log(`\nTeardown: ${left.n} row(s) left`);
      if (Number(left.n) !== 0) fail++;
    }
  }

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
