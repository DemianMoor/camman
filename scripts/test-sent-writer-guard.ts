// Guard: exactly ONE code path marks a stage_sends row 'sent' — the drain
// (lib/sends/drain.ts). Task 3 plan §4 (writer census, owner requirement).
//
// WHY. stage_sends.status = 'sent' is the single shared definition of "was
// messaged" (CLAUDE.md §10e): reports, the send breakers, the engagement job
// (contact_engagement.last_sent_at) and the "Texted in the last…" segment rule
// with its nightly trial all read it. The rule's lag tail and the trial's
// ground truth assume the drain is the only writer. A second writer — a
// backfill, an import, a "mark as sent" shortcut writing synthetic rows — would
// change all of them at once, silently. This makes it a red build instead.
//
// Scans app/ and lib/ (.ts/.tsx). A write is:
//   raw SQL   an UPDATE stage_sends … SET … status = 'sent', or an
//             INSERT INTO stage_sends whose text carries 'sent'
//   drizzle   .update(stage_sends) … .set({ … status: "sent" … })
//             .insert(stage_sends) … status: "sent"
// Reads (WHERE / FILTER / IN (...)) are not writes. A NEW writer must be added
// to ALLOWED with the owner's approval, after checking every reader above.
//
// Self-test first: the matcher must flag the bad snippets and pass the good
// ones, or it proves nothing.
//
//   npx tsx scripts/test-sent-writer-guard.ts      (part of npm run check:guards)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ALLOWED = new Set(["lib/sends/drain.ts"]);

/** Returns a short description of each 'sent' write to stage_sends in `src`. */
export function findSentWrites(src: string): string[] {
  const hits: string[] = [];
  // Raw SQL: look inside each template literal.
  for (const m of src.matchAll(/`([^`]*)`/g)) {
    const t = m[1];
    if (/UPDATE\s+(public\.)?stage_sends\b/i.test(t) && /\bSET\b[\s\S]*?\bstatus\s*=\s*'sent'/i.test(t))
      hits.push(`raw UPDATE stage_sends SET status = 'sent'`);
    else if (/INSERT\s+INTO\s+(public\.)?stage_sends\b/i.test(t) && /'sent'/.test(t))
      hits.push(`raw INSERT INTO stage_sends … 'sent'`);
  }
  // Drizzle: .update(stage_sends) / .insert(stage_sends) followed closely by status: "sent".
  for (const m of src.matchAll(/\.(update|insert)\(\s*stage_sends\s*\)([\s\S]{0,600})/g)) {
    if (/\bstatus\s*:\s*["']sent["']/.test(m[2])) hits.push(`drizzle .${m[1]}(stage_sends) with status: "sent"`);
  }
  return hits;
}

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

// ── self-test ──────────────────────────────────────────────────────────────
const BAD = [
  "await db.execute(sql`UPDATE stage_sends SET status = 'sent', sent_at = now() WHERE id = 1`)",
  "await db.execute(sql`update public.stage_sends s set attempts = 1, status='sent' where s.id = 2`)",
  "await db.execute(sql`INSERT INTO stage_sends (org_id, status) VALUES ($1, 'sent')`)",
  "await tx.update(stage_sends).set({ status: \"sent\", sent_at: new Date() }).where(eq(stage_sends.id, 1))",
  "await tx.insert(stage_sends).values({ org_id, status: 'sent' })",
];
const GOOD = [
  "await db.execute(sql`SELECT count(*) FROM stage_sends WHERE status = 'sent'`)",
  "await db.execute(sql`UPDATE stage_sends SET status = 'cancelled' WHERE status IN ('pending','sending')`)",
  "await db.execute(sql`UPDATE campaign_stages SET status = 'sent' WHERE id = 1`)",
  "await tx.update(stage_sends).set({ status: \"failed\" }).where(eq(stage_sends.status, \"sent\"))",
];
bar("self-test: every bad snippet is flagged", BAD.every((b) => findSentWrites(b).length > 0),
  BAD.filter((b) => findSentWrites(b).length === 0).join(" | "));
bar("self-test: no good snippet is flagged", GOOD.every((g) => findSentWrites(g).length === 0),
  GOOD.filter((g) => findSentWrites(g).length > 0).join(" | "));

// ── scan ──────────────────────────────────────────────────────────────────
const root = process.cwd();
const files: string[] = [];
const walk = (dir: string) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "node_modules" && !e.startsWith(".")) walk(p);
    } else if (/\.(ts|tsx)$/.test(e)) files.push(p);
  }
};
walk(join(root, "app"));
walk(join(root, "lib"));

const found: string[] = [];
let allowedSeen = 0;
for (const f of files) {
  const rel = relative(root, f).replace(/\\/g, "/");
  const hits = findSentWrites(readFileSync(f, "utf8"));
  if (hits.length === 0) continue;
  if (ALLOWED.has(rel)) allowedSeen += hits.length;
  else found.push(...hits.map((h) => `${rel}: ${h}`));
}
bar(`no writer of stage_sends 'sent' outside ${[...ALLOWED].join(", ")} (${files.length} files scanned)`,
  found.length === 0, found.join("; "));
bar("the drain's own writer is still found (the scan is not blind)", allowedSeen >= 1, `${allowedSeen} in the drain`);

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
