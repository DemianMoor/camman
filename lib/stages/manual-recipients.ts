import { sql, type SQL } from "drizzle-orm";

// Manual sends, made visible (migration 0197, Task 3 §4b / T2b).
//
// A manual stage is exported as a CSV, texted in an external provider and then
// marked 'sent'. None of that writes stage_sends, so stage_manual_recipients is
// the only record that those contacts were texted. Two writers, both here:
//
//   recordExportedRecipients    export-phones, per streamed chunk. Idempotent
//                               (PK stage_id, contact_id); several exports
//                               union. sent_at stays NULL: exported is not sent.
//   syncManualRecipientsOnStatus  the stage status routes, in the SAME
//                               transaction as the status change.
//
// Stage status is freely assignable (an operator may go pending → success
// after importing results, never passing 'sent'), so "was texted" is not
// 'sent' alone. The rule errs toward NOT texting the same people twice:
//   entering sent / success / failed → stamp sent_at = now() on unmarked rows
//                                      (failed = sent, poor result)
//   moving to draft / pending        → clear (an explicit "not sent": a
//                                      mistaken mark is undone)
//   cancelled / archived             → no change (neither proves nothing was
//                                      sent; an existing record is kept)
//
// Read by the "Texted in the last…" rule and its nightly ground truth only.

type Exec = { execute: (q: SQL) => Promise<unknown> };

const TEXTED: ReadonlySet<string> = new Set(["sent", "success", "failed"]);
const NOT_SENT: ReadonlySet<string> = new Set(["draft", "pending"]);

export async function recordExportedRecipients(
  dbc: Exec,
  p: { orgId: string; stageId: number; contactIds: string[] },
): Promise<void> {
  if (p.contactIds.length === 0) return;
  // ⚠️ Bind the ids as ONE array literal: a JS array interpolated into a
  // drizzle sql template is flattened into positional params.
  await dbc.execute(sql`
    INSERT INTO stage_manual_recipients (org_id, stage_id, contact_id)
    SELECT ${p.orgId}::uuid, ${p.stageId}::int, unnest(${`{${p.contactIds.join(",")}}`}::uuid[])
    ON CONFLICT (stage_id, contact_id) DO NOTHING`);
}

export async function syncManualRecipientsOnStatus(
  tx: Exec,
  p: { orgId: string; stageId: number; from: string; next: string },
): Promise<void> {
  if (TEXTED.has(p.next)) {
    await tx.execute(sql`
      UPDATE stage_manual_recipients SET sent_at = now()
      WHERE org_id = ${p.orgId}::uuid AND stage_id = ${p.stageId}::int AND sent_at IS NULL`);
  } else if (NOT_SENT.has(p.next)) {
    await tx.execute(sql`
      UPDATE stage_manual_recipients SET sent_at = NULL
      WHERE org_id = ${p.orgId}::uuid AND stage_id = ${p.stageId}::int AND sent_at IS NOT NULL`);
  }
}
