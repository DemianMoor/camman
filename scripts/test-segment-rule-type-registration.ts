import "./_env-preload";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { RULE_TYPE_KEYS } from "@/lib/validators/segment-rule-types";

// A segment rule type must be registered in SEVEN places. This guard asserts
// the three that are LISTS of rule-type names, and that they agree exactly:
//
//   1. RULE_TYPES                    lib/validators/segment-rule-types.ts   <- source of truth
//   6. segment_rules_rule_type_check the DB CHECK constraint
//   7. the same CHECK mirrored in    db/schema.ts
//
// (2 validateValueByShape, 3 isRuleComplete, 4 verifyValueOwnership and
//  5 the SQL emitter are per-shape branches, not lists — they are covered by
//  scripts/test-segment-rule-contact-attributes.ts, which creates each type
//  through the real API.)
//
// ⭐ WHY THIS EXISTS. docs/07-conventions.md documented FOUR places. Building
// the contact_attributes rules found a fifth (the SQL emitter), a sixth (this
// DB CHECK) and a seventh (its schema.ts mirror). A type missing from the DB
// CHECK validates in Zod, passes ownership, renders in the UI — and then the
// INSERT is rejected by Postgres. That is exactly how phone_type / carrier
// shipped uncreatable in 0098, one layer deeper. Nothing asserted these lists
// agreed until now.
//
// ⭐ IT MUST BE ABLE TO GO RED. It reports the two directions separately
// (declared-but-not-in-DB, in-DB-but-not-declared) and prints the actual sets,
// so a PASS names what it compared rather than asserting an empty intersection.
//
// Read-only.

function parseSchemaTsCheck(): string[] {
  const src = readFileSync(resolve(process.cwd(), "db/schema.ts"), "utf8");
  const marker = '"segment_rules_rule_type_check"';
  const at = src.indexOf(marker);
  if (at === -1) throw new Error("segment_rules_rule_type_check not found in db/schema.ts");
  // The check body runs to the closing backtick of the sql`` template.
  const open = src.indexOf("`", at);
  const close = src.indexOf("`", open + 1);
  const body = src.slice(open + 1, close);
  return [...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

async function parseDbCheck(): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'public.segment_rules'::regclass
      AND conname  = 'segment_rules_rule_type_check'
  `)) as unknown as { def: string }[];
  if (!rows[0]) throw new Error("segment_rules_rule_type_check not found in the database");
  return [...rows[0].def.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]);
}

function diff(a: string[], b: string[]): string[] {
  const B = new Set(b);
  return a.filter((x) => !B.has(x)).sort();
}

async function main() {
  const declared = [...RULE_TYPE_KEYS].sort();
  const schemaTs = parseSchemaTsCheck().sort();
  const dbCheck = (await parseDbCheck()).sort();

  console.log(`RULE_TYPES (source of truth) : ${declared.length} types`);
  console.log(`db/schema.ts CHECK mirror    : ${schemaTs.length} types`);
  console.log(`DB constraint (live)         : ${dbCheck.length} types`);

  let failures = 0;
  const report = (label: string, missing: string[]) => {
    if (missing.length === 0) {
      console.log(`  PASS  ${label}`);
    } else {
      failures++;
      console.log(`  FAIL  ${label}: ${missing.join(", ")}`);
    }
  };

  report("every declared type is in the DB CHECK (else INSERT is rejected)", diff(declared, dbCheck));
  report("every DB CHECK type is declared (else a dead value is allowed)", diff(dbCheck, declared));
  report("every declared type is in the db/schema.ts mirror", diff(declared, schemaTs));
  report("every db/schema.ts type is declared", diff(schemaTs, declared));
  report("db/schema.ts mirror matches the live DB constraint", diff(schemaTs, dbCheck));
  report("live DB constraint matches the db/schema.ts mirror", diff(dbCheck, schemaTs));

  if (failures > 0) {
    console.log(
      "\nA type present in RULE_TYPES but absent from the DB CHECK is UNCREATABLE:\n" +
        "it validates in Zod, passes ownership, renders in the UI, and then the\n" +
        "INSERT fails with a check_violation. Widen the constraint in a migration\n" +
        "(see 0148) and mirror it in db/schema.ts.",
    );
  }
  console.log(failures === 0 ? "\nAll registration lists agree." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
