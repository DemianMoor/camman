import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import type { DlrEvent } from "@/lib/sends/providers/types";

// Any drizzle executor — the top-level client or a transaction handle. Same
// shape as kickoff.ts's DbOrTx (not imported from there to avoid an odd
// cross-module dependency for a one-line type alias).
export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CaptureAhoiDlrOpts {
  orgId: string;
  credentialId: number;
  providerId: number;
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  rawBody: string | null;
  // Raw source/destination for archival — DlrEvent doesn't carry these (that
  // type only holds what reconcile needs), so the route extracts them
  // separately via extractAhoiWebhookFields and passes them here.
  fields: Record<string, string>;
  parsed: DlrEvent | null;
}

// Append-only raw+parsed capture. Never throws on a malformed/unparseable
// payload — parsed may be null (e.g. no uuid), in which case only the raw
// archival columns + fields.source/destination land; result/processed_at/
// matched_stage_send_id stay NULL until reconcileAhoiDlrEvent runs (Task 5).
export async function captureAhoiDlrEvent(
  dbc: DbOrTx,
  o: CaptureAhoiDlrOpts,
): Promise<{ id: string }> {
  const rows = (await dbc.execute(sql`
    INSERT INTO ahoi_dlr_events
      (org_id, credential_id, provider_id, method, query, headers, raw_body,
       provider_uuid, source, destination, send_status, status, smpp_status, smpp_code, error)
    VALUES (${o.orgId}, ${o.credentialId}, ${o.providerId}, ${o.method},
            ${JSON.stringify(o.query)}::jsonb, ${JSON.stringify(o.headers)}::jsonb, ${o.rawBody},
            ${o.parsed?.providerUuid ?? null}, ${o.fields.source ?? null}, ${o.fields.destination ?? null},
            ${o.parsed?.sendStatus ?? null}, ${o.parsed?.status ?? null},
            ${o.parsed?.smppStatus ?? null}, ${o.parsed?.smppCode ?? null}, ${o.parsed?.error ?? null})
    RETURNING id
  `)) as unknown as { id: string }[];
  return { id: rows[0].id };
}
