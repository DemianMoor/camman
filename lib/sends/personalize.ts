// P4 Task 4: per-recipient rendering support for kickoff (spec §C3). Used ONLY
// for a stage whose message uses a contact tag; a tag-less stage keeps the
// one-body path, byte-identical.
import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import { checkRecipientBody, type RenderResult } from "@/lib/messages/render";
import type { RecipientData } from "@/lib/messages/tags";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The recipients' raw attributes. A separate read (not a join in
 * stageRecipientsSql) so a tag-less stage's recipient SQL stays byte-identical.
 * Contacts with no row are simply absent (⇒ every tag missing).
 */
export async function loadRecipientAttributes(dbc: DbOrTx, contactIds: string[]): Promise<Map<string, RecipientData>> {
  const out = new Map<string, RecipientData>();
  if (contactIds.length === 0) return out;
  // One bound text parameter cast to uuid[]: a JS array in a Drizzle sql
  // template would flatten into positional params.
  const rows = (await dbc.execute(sql`
    SELECT contact_id, first_name, zip, state FROM contact_attributes
    WHERE contact_id = ANY(${`{${contactIds.join(",")}}`}::uuid[])
  `)) as unknown as ({ contact_id: string } & RecipientData)[];
  for (const r of rows) out.set(r.contact_id, { first_name: r.first_name, zip: r.zip, state: r.state });
  return out;
}

export type ValidateResult =
  | { ok: true; total: number; noStop: number }
  | { ok: false; reason: "per_recipient_render_failed"; detail: string };

/**
 * PURE. Render EVERY recipient before anything is inserted (validate-all). The
 * eligibility layers already removed whoever lacks data or would breach the
 * segment limit, so a failure here is a parity bug between the SQL twins and
 * the renderer — fail closed, never send a partial stage. Bodies without opt-out
 * language are only COUNTED: the caller decides refuse (txr) vs one aggregated
 * dry-run alert.
 */
export function validateRecipientBodies(i: {
  recipients: { contact_id: string }[];
  attrs: Map<string, RecipientData>;
  render: (r: RecipientData) => RenderResult;
  maxSegments: number;
  hasStop: (body: string) => boolean;
}): ValidateResult {
  let noStop = 0;
  for (const r of i.recipients) {
    const data = i.attrs.get(r.contact_id) ?? { first_name: null, zip: null, state: null };
    const res = i.render(data);
    if (!res.ok) {
      return { ok: false, reason: "per_recipient_render_failed", detail: `contact ${r.contact_id}: {${res.tag}} missing` };
    }
    if (!checkRecipientBody(res.body, i.maxSegments).ok) {
      return { ok: false, reason: "per_recipient_render_failed", detail: `contact ${r.contact_id}: over ${i.maxSegments} segment(s)` };
    }
    if (!i.hasStop(res.body)) noStop++;
  }
  return { ok: true, total: i.recipients.length, noStop };
}
