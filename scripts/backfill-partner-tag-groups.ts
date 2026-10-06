import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import { ensurePartnerTagGroup, partnerTagGroupName } from "../lib/drip/groups";

// Put every existing real partner lead into its partner x tag group ("pml-aca"),
// the group drip intake now assigns going forward (lib/drip/enrichment.ts).
//   npx tsx scripts/backfill-partner-tag-groups.ts            # DRY RUN — no writes
//   npx tsx scripts/backfill-partner-tag-groups.ts --apply    # writes
//   ... --partner=pml                                          # one partner slug only
// Idempotent: groups are upserted, memberships ON CONFLICT DO NOTHING.
// Sandbox lead events are never touched.
const APPLY = process.argv.includes("--apply");
const PARTNER = process.argv.find((a) => a.startsWith("--partner="))?.slice("--partner=".length) ?? null;

async function main() {
  const combos = (await db.execute(sql`
    SELECT org_id, partner_slug, interest_tag, count(DISTINCT contact_id)::int AS contacts
    FROM lead_events
    WHERE sandbox = false
      AND (${PARTNER}::text IS NULL OR partner_slug = ${PARTNER})
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
  `)) as unknown as { org_id: string; partner_slug: string; interest_tag: string | null; contacts: number }[];

  for (const c of combos) {
    const name = partnerTagGroupName(c.partner_slug, c.interest_tag);
    if (!APPLY) {
      console.log(`[dry-run] ${name}: ${c.contacts} contacts`);
      continue;
    }
    const added = await db.transaction(async (tx) => {
      const groupId = await ensurePartnerTagGroup(tx, {
        orgId: c.org_id, partnerSlug: c.partner_slug, interestTag: c.interest_tag,
      });
      // IS NOT DISTINCT FROM: a NULL tag must match NULL-tagged events.
      const rows = (await tx.execute(sql`
        INSERT INTO contact_contact_groups (contact_id, contact_group_id, org_id)
        SELECT DISTINCT e.contact_id, ${groupId}, e.org_id
        FROM lead_events e
        WHERE e.org_id = ${c.org_id}::uuid AND e.sandbox = false
          AND e.partner_slug = ${c.partner_slug}
          AND e.interest_tag IS NOT DISTINCT FROM ${c.interest_tag}
        ON CONFLICT DO NOTHING
        RETURNING contact_id
      `)) as unknown as unknown[];
      return { groupId, added: rows.length };
    });
    console.log(`${name} (group ${added.groupId}): +${added.added} of ${c.contacts} contacts`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
