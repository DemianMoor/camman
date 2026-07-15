import { sql } from "drizzle-orm";

import type { InboundEvent } from "@/lib/sends/providers/types";
import type { DbOrTx } from "@/lib/sends/ahoi-dlr";

export interface CaptureAhoiInboundOpts {
  orgId: string;
  credentialId: number;
  providerId: number;
  method: string;
  rawBody: string | null;
  parsed: InboundEvent | null;
}

// Append-only raw+parsed capture, source='webhook'. NO reconcile, NO
// opt_outs write — Section 4 (spec §6) reads these rows and does the keyword
// match + contact upsert + suppression. Never throws on an unparseable
// payload (parsed may be null); the raw row still lands either way so the
// payload contract is always recoverable from real data.
export async function captureAhoiInboundEvent(
  dbc: DbOrTx,
  o: CaptureAhoiInboundOpts,
): Promise<{ id: string }> {
  const rows = (await dbc.execute(sql`
    INSERT INTO ahoi_inbound_events
      (org_id, credential_id, provider_id, source, source_number, destination_number,
       message, type, cost, method, raw_body)
    VALUES (${o.orgId}, ${o.credentialId}, ${o.providerId}, 'webhook',
            ${o.parsed?.source ?? null}, ${o.parsed?.destination ?? null},
            ${o.parsed?.message ?? null}, ${o.parsed?.type ?? null},
            ${o.parsed?.cost ? Number(o.parsed.cost) : null}, ${o.method}, ${o.rawBody})
    RETURNING id
  `)) as unknown as { id: string }[];
  return { id: rows[0].id };
}
