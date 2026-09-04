import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { loadAliasTable } from "@/lib/authz/redact";

// Seed provider_route_aliases for every org (ClickUp 869evpmbz).
//
// Run: npx tsx --conditions=react-server scripts/seed-provider-route-aliases.ts
// (`--conditions=react-server` because the module graph reaches `server-only`.)
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// The table has been empty in production since migration 0175 shipped, because
// loadAliasTable() seeds LAZILY — on the first operator page load — and no
// operator has ever signed in (org_members held exactly one row, the Owner).
// So the redactor has never actually executed against production data. "Route A
// hides TextHub" is, today, a claim tested only against preview.
//
// It must be populated BEFORE the hire, not on their first request, for one
// specific reason: the letters are assigned in provider-id order at seed time
// and then STABLE FOREVER. Seeding here, deliberately, means the Owner can see
// and sanity-check the mapping before anyone relies on it. Letting the new
// operator's first page load assign them means the mapping is decided by
// whoever happens to load a page first.
//
// ── IT CALLS loadAliasTable() RATHER THAN REIMPLEMENTING IT ────────────────
//
// ⚠️ THIS IS THE WHOLE POINT OF THE SCRIPT'S DESIGN. A seed that computed its
// own letters would be a SECOND implementation of the assignment rule, and the
// two would only have to disagree once — on the day a provider is added between
// a seed run and a lazy load — to produce two different "Route B"s. Calling the
// real function makes divergence impossible: this produces exactly what a
// lazy seed would have produced, just earlier and where someone can read it.
//
// Idempotent by construction — loadAliasTable() inserts ON CONFLICT DO NOTHING
// and never reassigns an existing alias. Safe to re-run after adding a provider.
//
// ⚠️ READ-ONLY WITH RESPECT TO EVERYTHING ELSE. It writes provider_route_aliases
// and nothing else. Nowhere near the send path.

async function main() {
  const orgs = (await db.execute(
    sql`SELECT id::text AS id, name FROM organizations ORDER BY name`,
  )) as unknown as { id: string; name: string }[];

  if (orgs.length === 0) {
    console.log("No organizations found.");
    return;
  }

  for (const org of orgs) {
    const providers = (await db.execute(sql`
      SELECT id, name, sms_provider_id AS code, status
      FROM sms_providers
      WHERE org_id = ${org.id}::uuid
      ORDER BY id
    `)) as unknown as {
      id: number;
      name: string;
      code: string;
      status: string;
    }[];

    const before = (await db.execute(sql`
      SELECT count(*)::int AS n FROM provider_route_aliases WHERE org_id = ${org.id}::uuid
    `)) as unknown as { n: number }[];

    const table = await loadAliasTable(org.id);

    const after = (await db.execute(sql`
      SELECT count(*)::int AS n FROM provider_route_aliases WHERE org_id = ${org.id}::uuid
    `)) as unknown as { n: number }[];

    console.log(`\n${org.name} (${org.id})`);
    console.log(
      `  aliases: ${before[0]?.n ?? 0} before -> ${after[0]?.n ?? 0} after ` +
        `(${providers.length} provider${providers.length === 1 ? "" : "s"})`,
    );
    for (const p of providers) {
      const alias = table.byId.get(p.id);
      // Archived providers are aliased too. loadAliasTable() orders by id over
      // ALL providers, so skipping them here would print a different mapping
      // from the one actually stored — and worse, would imply the letters
      // shift when a provider is archived. They do not.
      const archived = p.status === "archived" ? "  (archived)" : "";
      console.log(
        `    ${String(alias ?? "—").padEnd(9)} <- ${p.name} [${p.code}]${archived}`,
      );
    }
  }

  console.log(
    "\nAliases are STABLE from here on. An operator refers to routes by these " +
      "letters, so a letter that moves is worse than no alias at all.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
