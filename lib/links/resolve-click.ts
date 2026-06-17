import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import {
  classifyClick,
  type ClickClassification,
  type PrefetchSignals,
} from "@/lib/links/classify-click";
import { appendUrlParam } from "@/lib/stage-url";

// The query-param name that carries the per-recipient customer id into Keitaro.
// Mirrors the STAGE_TRACKING_PARAM ("sub_id3") spelling convention: NO underscore
// in the URL param; Keitaro's campaign Parameters tab maps it onto the `sub_id_1`
// token (underscore) on the read/report side. The value is the link's send_token
// (= stage_sends.id), so a Keitaro sale's sub_id_1 maps 1:1 back to the recipient.
export const RECIPIENT_SUB_ID_PARAM = "sub_id1";

// Accept either the top-level `db` or a transaction handle (the latter lets
// the verify script roll everything back).
export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ResolveClickInput {
  code: string;
  ip?: string | null;
  userAgent?: string | null;
  referer?: string | null;
  prefetch?: PrefetchSignals;
}

export interface ResolveClickResult {
  destinationUrl: string;
  classification: ClickClassification;
}

// Resolve a short code to its destination and log the click. Returns null
// when no link matches the code (the route turns that into a 404).
//
// Logging is BEST-EFFORT: a failed clicks insert is swallowed (and logged to
// the server console) so it can never stop a real recipient from reaching the
// destination. The lookup, by contrast, must succeed — without it there's no
// URL to redirect to.
export async function resolveAndLogClick(
  dbc: DbOrTx,
  input: ResolveClickInput,
): Promise<ResolveClickResult | null> {
  const lookup = (await dbc.execute(sql`
    SELECT l.id AS link_id, l.org_id AS org_id, d.url AS destination_url,
           l.send_token AS send_token
    FROM links l
    JOIN link_destinations d ON d.id = l.destination_id
    WHERE l.code = ${input.code}
    LIMIT 1
  `)) as unknown as {
    link_id: number;
    org_id: string;
    destination_url: string;
    send_token: string;
  }[];

  const row = lookup[0];
  if (!row) return null;

  // Append the per-recipient customer id (= send_token = stage_sends.id) as the
  // sub_id1 param so Keitaro can attribute a sale back to this exact recipient.
  // The shared per-stage destination is left untouched in link_destinations; the
  // recipient-specific param is added only here, at redirect time. appendUrlParam
  // is a no-op if the key is somehow already present. send_token is NOT NULL on
  // links, so every tracked link carries it.
  const destinationUrl = appendUrlParam(
    row.destination_url,
    RECIPIENT_SUB_ID_PARAM,
    row.send_token,
  );

  const classification = classifyClick(input.userAgent, input.prefetch);

  try {
    await dbc.execute(sql`
      INSERT INTO clicks (org_id, link_id, ip, user_agent, referer, classification)
      VALUES (
        ${row.org_id}, ${Number(row.link_id)}, ${input.ip ?? null},
        ${input.userAgent ?? null}, ${input.referer ?? null}, ${classification}
      )
    `);
  } catch (err) {
    // Never let a logging failure break the redirect.
    console.error(`resolveAndLogClick: failed to log click for code ${input.code}`, err);
  }

  return { destinationUrl, classification };
}
