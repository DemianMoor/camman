import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";

import {
  COUNTED_CONVERSION_STATUSES,
  approvedRevenueClause,
  legacySaleStatusPurchasedClause,
  pendingRevenueClause,
  purchasedClause,
  purchasedSendIds,
  registeredClause,
  rescueSendIds,
} from "../lib/sale-attribution";

// PURE. No DB, no network. Asserts the RENDERED SQL of the shared conversion
// predicates, so a call site can never silently pick up a different definition.
//   npx tsx scripts/test-ledger-predicates.ts

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const render = (q: SQL) => new PgDialect().sqlToQuery(q).sql.replace(/\s+/g, " ").trim();
const params = (q: SQL) => new PgDialect().sqlToQuery(q).params;

function main() {
  const purchased = render(purchasedClause());
  console.log(`Rendered purchasedClause(): ${purchased}\n`);

  check(
    "P1 purchasedClause reads the is_purchase flag off event_types",
    purchased.includes("ce.event_type_id IN (SELECT et.id FROM event_types et WHERE et.is_purchase)"),
    purchased,
  );
  check(
    "P2 purchasedClause counts pending + approved and NOT rejected",
    purchased.includes("ce.status IN ('pending', 'approved')") && !purchased.includes("rejected"),
    purchased,
  );
  check("P3 the alias is honoured", render(purchasedClause("x")).startsWith("x.event_type_id IN"));
  check(
    "P4 approvedRevenueClause is counts_revenue AND approved only",
    render(approvedRevenueClause()) ===
      "ce.event_type_id IN (SELECT et.id FROM event_types et WHERE et.counts_revenue) AND ce.status = 'approved'",
    render(approvedRevenueClause()),
  );
  check(
    "P5 pendingRevenueClause is the same flag with status pending",
    render(pendingRevenueClause()).endsWith("ce.status = 'pending'") &&
      render(pendingRevenueClause()).includes("et.counts_revenue"),
    render(pendingRevenueClause()),
  );
  check(
    "P6 registeredClause reads is_retarget_signal, pending + approved",
    render(registeredClause()).includes("et.is_retarget_signal") &&
      render(registeredClause()).includes("ce.status IN ('pending', 'approved')"),
    render(registeredClause()),
  );
  check(
    "P7 ⭐ no predicate filters event_types.status — archiving a type must not erase history",
    ![purchased, render(approvedRevenueClause()), render(pendingRevenueClause()), render(registeredClause())].some(
      (t) => t.includes("et.status"),
    ),
  );
  check(
    "P8 the legacy column predicate is still available for the proof script",
    render(legacySaleStatusPurchasedClause()) === "ss.sale_status IN ('lead', 'sale')",
    render(legacySaleStatusPurchasedClause()),
  );
  const sends = purchasedSendIds("11111111-1111-1111-1111-111111111111");
  check(
    "P9 purchasedSendIds binds the org id and skips rows with no recipient",
    params(sends).length === 1 &&
      render(sends).includes("ce.org_id = $1::uuid") &&
      render(sends).includes("ce.stage_send_id IS NOT NULL") &&
      render(sends).includes("SELECT DISTINCT ce.stage_send_id"),
    render(sends),
  );
  const rescue = render(rescueSendIds("11111111-1111-1111-1111-111111111111"));
  check(
    "P10 rescueSendIds covers purchase OR revenue types, excludes rejected, groups per send row",
    rescue.includes("et.is_purchase") &&
      rescue.includes("et.counts_revenue") &&
      rescue.includes("ce.status IN ('pending', 'approved')") &&
      rescue.includes("min(ce.occurred_at) AS first_event_at") &&
      rescue.endsWith("GROUP BY 1"),
    rescue,
  );
  check(
    "P11 the rescue window fragment is appended before the GROUP BY",
    render(rescueSendIds("11111111-1111-1111-1111-111111111111", sql`AND ce.updated_at >= now()`)).includes(
      "AND ce.updated_at >= now() GROUP BY 1",
    ),
  );
  check(
    "P12 COUNTED_CONVERSION_STATUSES is exactly pending + approved",
    JSON.stringify(COUNTED_CONVERSION_STATUSES) === '["pending","approved"]',
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
