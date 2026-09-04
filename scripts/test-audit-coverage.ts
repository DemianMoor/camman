// RUN WITH: npx tsx --conditions=react-server scripts/test-audit-coverage.ts
import "./_env-preload";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";

// Confirms every Phase 3 BLOCK and WARN writes audit_log (869et3vm1 Phase 4).
//
// Two halves, because either alone is misleading:
//
//   1. STATIC — every guardrail event in the union is actually emitted from
//      somewhere in the codebase. A declared event nobody raises is a hole that
//      no amount of database inspection will reveal, because the absence looks
//      identical to "it just hasn't happened yet".
//
//   2. LIVE — for each event that HAS occurred, print a real row. This is the
//      "one sample row each" the brief asks for, and it is the half that proves
//      the write actually lands rather than merely being coded.
//
// ⚠️ An event with no live row is reported as NOT-YET-OBSERVED, not as a
// failure. Several of these fire only under conditions that have not arisen in
// this environment (nobody has hit a cap in preview), and failing on that would
// be a guard that goes red for being correct.

const GUARDRAIL_EVENTS = [
  "guardrail.cap_blocked",
  "guardrail.cap_exceeded",
  "guardrail.url_rejected",
  "guardrail.creative_forked",
  "guardrail.deletion_requested",
  "guardrail.deletion_decided",
  "guardrail.unproven_creative",
  "guardrail.volume_deviation",
  "guardrail.frequency_collision",
] as const;

// Where each is expected to be raised, so a missing emitter names its own file.
const EMITTERS: Record<string, string[]> = {
  // Per-stage cap only. The aggregate cap became warn-only on 2026-09-04 and
  // now raises guardrail.cap_exceeded instead.
  "guardrail.cap_blocked": [
    "app/api/campaigns/[campaignId]/stages/[stageId]/send/kickoff/route.ts",
  ],
  "guardrail.cap_exceeded": [
    "app/api/campaigns/[campaignId]/stages/[stageId]/send/approve-send/route.ts",
    "app/api/campaigns/[campaignId]/stages/[stageId]/send/retry-failed/route.ts",
  ],
  "guardrail.url_rejected": [
    "app/api/creatives/route.ts",
    "app/api/creatives/[id]/route.ts",
  ],
  "guardrail.creative_forked": ["app/api/creatives/[id]/route.ts"],
  "guardrail.deletion_requested": ["lib/guardrails/deletion-requests.ts"],
  "guardrail.deletion_decided": ["lib/guardrails/deletion-requests.ts"],
  "guardrail.unproven_creative": ["lib/guardrails/prepare.ts"],
  "guardrail.volume_deviation": ["lib/guardrails/prepare.ts"],
  "guardrail.frequency_collision": ["lib/sends/send-preflight.ts"],
};

let failures = 0;
const ok = (m: string) => console.log(`  OK ${m}`);
const bad = (m: string) => {
  console.log(`  XX ${m}`);
  failures++;
};

async function main() {
  console.log("=== audit coverage for Phase 3 guardrails ===\n");

  // ── 1. every declared event has an emitter ──────────────────────────────
  console.log("--- 1. every guardrail event is raised somewhere ---");
  console.log(`  scope: ${GUARDRAIL_EVENTS.length} declared events`);
  // Widened to string[] so the emptiness guard is a real runtime check rather
  // than a comparison TypeScript can prove false against the const tuple.
  if ((GUARDRAIL_EVENTS as readonly string[]).length === 0) {
    bad("EMPTY event list");
    process.exit(1);
  }
  for (const ev of GUARDRAIL_EVENTS) {
    const files = EMITTERS[ev] ?? [];
    const found = files.filter((f) => {
      try {
        return readFileSync(resolve(process.cwd(), f), "utf8").includes(`"${ev}"`);
      } catch {
        return false;
      }
    });
    if (found.length > 0) ok(`${ev} raised in ${found.length} file(s): ${found[0]}`);
    else bad(`${ev} is DECLARED BUT NEVER RAISED — expected in ${files.join(", ")}`);
  }

  // ── 2. the notify path always writes audit before Telegram ──────────────
  console.log("\n--- 2. audit is written before Telegram, unconditionally ---");
  const notify = readFileSync(resolve(process.cwd(), "lib/guardrails/notify.ts"), "utf8");
  console.log(`  scope: lib/guardrails/notify.ts (${notify.length} bytes)`);
  const auditIdx = notify.indexOf("writeAuditLog");
  const tgIdx = notify.indexOf("notifyTelegram(");
  if (auditIdx === -1) bad("notify.ts does not call writeAuditLog at all");
  else if (tgIdx === -1) bad("notify.ts does not call notifyTelegram at all");
  else if (auditIdx < tgIdx) {
    ok("writeAuditLog precedes notifyTelegram — a Telegram outage cannot cost the record");
  } else {
    bad("notifyTelegram runs BEFORE writeAuditLog — an outage would lose the record");
  }

  // ── 3. one real sample row per event that has occurred ──────────────────
  console.log("\n--- 3. sample rows from audit_log ---");
  const counts = (await db.execute(sql`
    SELECT action, count(*)::int AS n FROM audit_log GROUP BY action ORDER BY action
  `)) as unknown as { action: string; n: number }[];
  const seen = new Map(counts.map((c) => [c.action, c.n]));
  console.log(`  scope: ${counts.length} distinct action(s) present in audit_log`);
  if (counts.length === 0) {
    bad("audit_log is EMPTY — nothing has ever been recorded");
  }

  let observed = 0;
  for (const ev of GUARDRAIL_EVENTS) {
    const n = seen.get(ev) ?? 0;
    if (n === 0) {
      console.log(`  ·  ${ev}: not yet observed in this environment`);
      continue;
    }
    observed++;
    const [row] = (await db.execute(sql`
      SELECT to_char(created_at, 'YYYY-MM-DD HH24:MI') AS at,
             coalesce(entity_type, '-') AS entity_type,
             coalesce(entity_id, '-') AS entity_id,
             left(summary, 150) AS summary
      FROM audit_log WHERE action = ${ev}
      ORDER BY created_at DESC LIMIT 1
    `)) as unknown as { at: string; entity_type: string; entity_id: string; summary: string }[];
    ok(`${ev} (${n}) — ${row.at} · ${row.entity_type} ${row.entity_id} · "${row.summary}"`);
  }
  console.log(`     ${observed}/${GUARDRAIL_EVENTS.length} guardrail events observed live here`);

  // Auth/account events too — Phase 1/2 coverage, same table.
  console.log("\n--- 4. auth and account events ---");
  const authEvents = counts.filter(
    (c) => c.action.startsWith("auth.") || c.action.startsWith("user."),
  );
  console.log(`  scope: ${authEvents.length} auth/account action(s)`);
  if (authEvents.length === 0) {
    console.log("  ·  none observed in this environment");
  }
  for (const a of authEvents) {
    const [row] = (await db.execute(sql`
      SELECT to_char(created_at, 'YYYY-MM-DD HH24:MI') AS at, left(summary, 120) AS summary
      FROM audit_log WHERE action = ${a.action} ORDER BY created_at DESC LIMIT 1
    `)) as unknown as { at: string; summary: string }[];
    ok(`${a.action} (${a.n}) — ${row.at} · "${row.summary}"`);
  }

  console.log(`\n=== ${failures === 0 ? "ALL PASS" : "FAILURES"} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("threw:", e instanceof Error ? e.message : e);
  process.exit(1);
});
