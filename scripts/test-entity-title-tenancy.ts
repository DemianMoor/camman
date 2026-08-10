import "./_env-preload";

import { randomUUID } from "node:crypto";

import { sql } from "../db/client";
import { getEntityName, type EntityKind } from "../lib/entity-name";

// Tenancy guard for the entity-name lookup behind detail-page browser tab
// titles (lib/entity-title.ts). READ-ONLY — no INSERT/UPDATE/DELETE.
//
// The org_id predicate is the load-bearing part: without it, guessing a
// sequential id would put another tenant's entity name in your browser tab.
// The DB currently holds a single org, so "an entity belonging to a DIFFERENT
// org" is simulated from the other side — a real entity id paired with an
// org_id that does not own it. That exercises the exact same SQL predicate a
// second tenant would hit.
//
// Run: npx tsx scripts/test-entity-title-tenancy.ts

type Case = { kind: EntityKind; table: string; label: string };

const CASES: Case[] = [
  { kind: "campaign", table: "campaigns", label: "Campaign" },
  { kind: "segment", table: "segments", label: "Segment" },
  { kind: "contact_group", table: "contact_groups", label: "Contact Group" },
  { kind: "sms_provider", table: "sms_providers", label: "SMS Provider" },
  { kind: "offer", table: "offers", label: "Offer Report" },
];

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail: string) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} — ${detail}`);
  }
}

async function main() {
  const foreignOrg = randomUUID();
  console.log(`synthetic non-owning org_id: ${foreignOrg}\n`);

  for (const c of CASES) {
    // Pick a real row with a usable name, read-only.
    const rows = await sql`
      SELECT id, org_id, name
      FROM ${sql(c.table)}
      WHERE name IS NOT NULL AND btrim(name) <> ''
      ORDER BY id
      LIMIT 1
    `;
    if (rows.length === 0) {
      console.log(`  SKIP  ${c.table}: no named rows to test against`);
      continue;
    }
    const { id, org_id, name } = rows[0] as {
      id: number;
      org_id: string;
      name: string;
    };
    console.log(`${c.table} #${id} ("${name}")`);

    // 1. Owning org resolves the real name.
    const owned = await getEntityName(c.kind, id, org_id);
    check(
      `${c.kind}: owning org resolves the name`,
      owned === name,
      `got ${JSON.stringify(owned)}, want ${JSON.stringify(name)}`,
    );

    // 2. THE TENANCY CHECK: a non-owning org must get nothing back, so the
    //    route falls back to its static title instead of leaking the name.
    const leaked = await getEntityName(c.kind, id, foreignOrg);
    check(
      `${c.kind}: non-owning org gets null (falls back to "${c.label}")`,
      leaked === null,
      `LEAKED ${JSON.stringify(leaked)} across tenants`,
    );

    // 3. Nonexistent id in the owning org.
    const missing = await getEntityName(c.kind, 2_000_000_000, org_id);
    check(
      `${c.kind}: nonexistent id -> null`,
      missing === null,
      `got ${JSON.stringify(missing)}`,
    );

    // 4. Malformed ids must not reach the DB or throw.
    for (const bad of [NaN, 0, -1, 1.5]) {
      const r = await getEntityName(c.kind, bad, org_id);
      check(
        `${c.kind}: malformed id ${String(bad)} -> null`,
        r === null,
        `got ${JSON.stringify(r)}`,
      );
    }
    console.log("");
  }

  console.log(`pass=${pass}  fail=${fail}`);
  await sql.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await sql.end().catch(() => {});
  process.exit(1);
});
