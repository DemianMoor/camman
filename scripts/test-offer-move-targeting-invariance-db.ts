import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// TASK 1b (per-offer conversion attribution): moving a conversion row to
// another offer (conversion_events.offer_id) must NEVER change who is excluded
// from a send or who a segment rule selects.
//
// Owner condition 2026-11-04. Recon found every targeting reader reaches the
// offer through ce.campaign_id -> campaigns.offer_id, never ce.offer_id. This
// is a PIN, not a red-first test: it passes on today's code. Its job is to go
// red the day a targeting reader starts reading ce.offer_id.
//
//   T1 purchasedOfferContacts(org, offer)                   lib/sale-attribution.ts
//   T2 the bought_offer layer of buildStageEligibilityExclusions   lib/sends/eligibility.ts
//   T3 recheckLifecycleEligibility (send-time re-check)     lib/sends/lifecycle-recheck.ts
//   T4 the made_purchase_for_offer segment rule             lib/segment-rules-eval.ts (ruleInnerQuery)
//   T5 source guard: no conversion_events alias `.offer_id` outside the allow-list
//
// Everything DB-side runs in ONE transaction that is always rolled back, on a
// throwaway org. Run (preview DB only):
//   DATABASE_URL="$(grep '^DATABASE_URL=' .env.demo | cut -d= -f2- | tr -d '\r\"')" \
//     npx tsx --conditions=react-server scripts/test-offer-move-targeting-invariance-db.ts

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { sql, type SQL } from "drizzle-orm";

const MARKER = "__OFFER_MOVE_INVARIANCE_TEST__";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

// ── T5: source guard ────────────────────────────────────────────────────────
// Only these files may read conversion_events.offer_id: the ingest that writes
// it, the monitor that groups alerts by it, and the offer-splits report.
const ALLOW = new Set([
  "lib/conversions/ingest.ts",
  "lib/conversions/monitor.ts",
  "lib/reporting/offer-splits.ts",
]);
const KEYWORDS = new Set([
  "where", "on", "join", "left", "right", "inner", "outer", "cross", "full",
  "using", "group", "order", "limit", "set", "as", "and", "or", "select",
  "values", "returning", "union", "except", "intersect", "for", "with",
]);
// Comment lines are ignored (`//`, `*`, `/*`, `--`) so prose that MENTIONS the
// column (lib/sale-attribution.ts explains why it is NOT read) is not a hit.
const isCommentLine = (l: string) => /^\s*(\/\/|\*|\/\*|--)/.test(l);

function sourceGuard(root: string): string[] {
  const files = execFileSync("git", ["ls-files", "lib", "db/migrations"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => /\.(ts|tsx|sql)$/.test(f));
  const hits: string[] = [];
  for (const f of files) {
    if (ALLOW.has(f)) continue;
    const lines = readFileSync(path.join(root, f), "utf8").split("\n");
    // Aliases for conversion_events declared anywhere in this file.
    const aliases = new Set(["ce", "conversion_events", "conversionEvents"]);
    for (const l of lines) {
      if (isCommentLine(l)) continue;
      for (const m of l.matchAll(
        /\bconversion_events\s+(?:AS\s+)?([a-z_][a-z0-9_]*)\b/gi,
      )) {
        if (!KEYWORDS.has(m[1].toLowerCase())) aliases.add(m[1]);
      }
    }
    const re = new RegExp(`\\b(?:${[...aliases].join("|")})\\.offer_id\\b`);
    lines.forEach((l, i) => {
      if (!isCommentLine(l) && re.test(l)) hits.push(`${f}:${i + 1}: ${l.trim()}`);
    });
  }
  return hits;
}

class Rollback extends Error {}

async function main() {
  const { requirePreviewDb } = await import("./_require-preview-db");
  const { fictionalPhones, refuseIfPhonesInUse } =
    await import("./_fictional-phones");
  const { db } = await import("@/db/client");
  const { purchasedOfferContacts } = await import("@/lib/sale-attribution");
  const { buildStageEligibilityExclusions } =
    await import("@/lib/sends/eligibility");
  const { recheckLifecycleEligibility } =
    await import("@/lib/sends/lifecycle-recheck");
  const { ruleInnerQuery } = await import("@/lib/segment-rules-eval");
  const { NO_TAG_RULES } = await import("@/lib/messages/render");
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  const phones = fictionalPhones(2);
  await refuseIfPhonesInUse(db, phones);

  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  try {
    await db.transaction(async (tx: Tx) => {
      const one = async <T>(q: SQL): Promise<T> =>
        ((await tx.execute(q)) as unknown as T[])[0];
      const ids = async (q: SQL): Promise<string[]> =>
        (
          (await tx.execute(
            sql`SELECT x.contact_id::text AS c FROM (${q}) x ORDER BY 1`,
          )) as unknown as { c: string }[]
        ).map((r) => r.c);

      const tag = `omi-${Date.now()}`;
      const orgId = (
        await one<{ id: string }>(
          sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${tag}`}) RETURNING id`,
        )
      ).id;
      const org = sql`${orgId}::uuid`;
      const net = await one<{ id: number }>(
        sql`INSERT INTO affiliate_networks (org_id, network_id, name) VALUES (${org}, ${`n-${tag}`}, ${`N ${tag}`}) RETURNING id`,
      );
      const brand = await one<{ id: number }>(
        sql`INSERT INTO brands (org_id, brand_id, name) VALUES (${org}, ${`b-${tag}`}, ${`B ${tag}`}) RETURNING id`,
      );
      const mkOffer = async (s: string) =>
        (
          await one<{ id: number }>(
            sql`INSERT INTO offers (org_id, offer_id, network_id, name) VALUES (${org}, ${`o${s}-${tag}`}, ${net.id}, ${`O${s} ${tag}`}) RETURNING id`,
          )
        ).id;
      const offerA = await mkOffer("a");
      const offerB = await mkOffer("b");
      const et = await one<{ id: number }>(sql`
        INSERT INTO event_types (org_id, key, label, is_purchase, counts_revenue)
        VALUES (${org}, 'sale', 'Sale', true, true) RETURNING id`);

      // Campaign on A. lifecycle_rules on, so the lifecycle layers apply.
      const camp = (
        await one<{ id: number }>(sql`
          INSERT INTO campaigns (org_id, slug, name, status, link_mode, brand_id, offer_id, lifecycle_rules)
          VALUES (${org}, ${`c-${tag}`}, ${`C ${tag}`}, 'active', 'manual', ${brand.id}, ${offerA}, true)
          RETURNING id`)
      ).id;
      const stage = (
        await one<{ id: number }>(sql`
          INSERT INTO campaign_stages (org_id, campaign_id, stage_number, stop_text)
          VALUES (${org}, ${camp}, 1, 'STOP') RETURNING id`)
      ).id;

      const mkContact = async (i: number) =>
        (
          await one<{ id: string }>(sql`
            INSERT INTO contacts (org_id, phone_number, lifecycle_status, line_type)
            VALUES (${org}, ${phones[i]}, 'cold', 'mobile') RETURNING id`)
        ).id;
      const c1 = await mkContact(0); // the buyer
      const c2 = await mkContact(1); // a control who never bought

      // ONE approved Purchase row on contact 1, offer_id = A, campaign = A's.
      await tx.execute(sql`
        INSERT INTO conversion_events
          (org_id, keitaro_event_id, keitaro_status, keitaro_type, contact_id,
           campaign_id, stage_id, offer_id, event_type_id, status, revenue, occurred_at)
        VALUES (${org}, ${`${tag}-buy`}, 'sale', 'sale', ${c1}::uuid,
                ${camp}, ${stage}, ${offerA}, ${et.id}, 'approved', '10.0000', now())`);

      // ── capture: everything targeting derives, as comparable strings ──────
      const capture = async () => {
        const out: Record<string, string> = {};
        // T1
        out.t1_A = JSON.stringify(await ids(purchasedOfferContacts(orgId, offerA)));
        out.t1_B = JSON.stringify(await ids(purchasedOfferContacts(orgId, offerB)));
        // T2 — the bought_offer layer for a draft stage on A and on B
        for (const [name, off] of [["A", offerA], ["B", offerB]] as const) {
          const layers = buildStageEligibilityExclusions({
            orgId,
            currentCampaignId: camp,
            currentCreativeId: null,
            currentOfferId: off,
            excludePriorOffer: false,
            offerRulesEnabled: false,
            offerCooldownDays: 0,
            offerLimitTimes: 0,
            lifecycleRules: true,
            carrierRejectedSuppression: false,
            tagRules: NO_TAG_RULES,
          });
          const layer = layers.find((l) => l.key === "bought_offer");
          out[`t2_${name}`] = layer
            ? JSON.stringify(await ids(layer.sql))
            : "NO_LAYER";
        }
        // T3 — send-time re-check on a batch of both contacts, per offer
        for (const [name, off] of [["A", offerA], ["B", offerB]] as const) {
          const rows = [c1, c2].map((c, i) => ({
            id: randomUUID(),
            phone: phones[i],
            contact_id: c,
          }));
          const res = await recheckLifecycleEligibility(tx, {
            orgId,
            campaignId: camp,
            offerId: off,
            lifecycleRules: true,
            rows,
          });
          out[`t3_${name}`] = JSON.stringify(
            rows.map((r) => `${r.contact_id}=${res.get(r.id) ?? "-"}`).sort(),
          );
        }
        // T4 — made_purchase_for_offer. buildSegmentAudienceClause reads the
        // segment + rules through the module-level pool, which cannot see this
        // transaction's uncommitted rows; ruleInnerQuery is the exported rule
        // builder it calls, so the rule's SQL is exercised without committing.
        for (const [name, off] of [["A", offerA], ["B", offerB]] as const) {
          out[`t4_${name}`] = JSON.stringify(
            await ids(
              ruleInnerQuery(
                { rule_type: "made_purchase_for_offer", operator: "is", value: off },
                0,
                orgId,
              ),
            ),
          );
        }
        return out;
      };

      const before = await capture();
      await tx.execute(
        sql`UPDATE conversion_events SET offer_id = ${offerB} WHERE org_id = ${org}`,
      );
      const moved = await one<{ n: string }>(
        sql`SELECT count(*) AS n FROM conversion_events WHERE org_id = ${org} AND offer_id = ${offerB}`,
      );
      const after = await capture();

      console.log("Fixture: campaign on A, buyer c1 (row offer_id A -> B), control c2\n");
      bar("precondition: the row really moved to offer B", Number(moved.n) === 1);
      // Non-vacuous: the buyer is found for A, nobody for B, before the move.
      bar(
        "control: before the move, A's buyers = [c1], B's = []",
        before.t1_A === JSON.stringify([c1]) && before.t1_B === "[]",
        `A=${before.t1_A} B=${before.t1_B}`,
      );
      bar(
        "control: the recheck flags c1 as bought_offer for A and nobody for B",
        before.t3_A.includes(`${c1}=bought_offer`) &&
          before.t3_A.includes(`${c2}=-`) &&
          !before.t3_B.includes("bought_offer"),
        `A=${before.t3_A}`,
      );

      console.log("\nInvariance after UPDATE conversion_events SET offer_id = B");
      const same = (label: string, keys: string[], detail: string) =>
        bar(
          label,
          keys.every((k) => before[k] === after[k]),
          keys.every((k) => before[k] === after[k])
            ? detail
            : keys.filter((k) => before[k] !== after[k])
                .map((k) => `${k}: ${before[k]} -> ${after[k]}`)
                .join("; "),
        );
      same("T1 purchasedOfferContacts identical for A and B", ["t1_A", "t1_B"], "A=[c1] B=[]");
      same("T2 bought_offer layer identical for a stage on A and on B", ["t2_A", "t2_B"], `A=${after.t2_A} B=${after.t2_B}`);
      same("T3 recheckLifecycleEligibility identical for A and B", ["t3_A", "t3_B"], `A=${after.t3_A}`);
      same("T4 made_purchase_for_offer identical for A and B", ["t4_A", "t4_B"], `A=${after.t4_A} B=${after.t4_B}`);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  console.log("\nT5 source guard (lib/ + db/migrations, comment lines ignored)");
  const hits = sourceGuard(process.cwd());
  bar(
    `T5 no conversion_events alias .offer_id outside ${[...ALLOW].join(", ")}`,
    hits.length === 0,
    hits.length ? `\n      ${hits.join("\n      ")}` : "0 hits",
  );

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
