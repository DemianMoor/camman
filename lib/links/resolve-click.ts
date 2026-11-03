import { sql } from "drizzle-orm";

import type { db } from "@/db/client";
import {
  classifyClick,
  type ClickClassification,
  type PrefetchSignals,
} from "@/lib/links/classify-click";
import {
  appendGeoParams,
  lookupGeoParamsFailOpen,
  NO_GEO,
  type GeoParams,
} from "@/lib/links/geo-params";
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

// Raw zip/state for a link's recipient, each only when its stage flag (0229) is
// on. A separate statement from the code lookup ON PURPOSE: it runs fail-open
// beside the clicks insert, so an error / slow plan here can never stop or
// delay a redirect past GEO_LOOKUP_BUDGET_MS.
export async function lookupGeoParams(
  dbc: DbOrTx,
  orgId: string,
  stageId: number,
  contactId: string,
): Promise<GeoParams> {
  const rows = (await dbc.execute(sql`
    SELECT s.url_add_zip, s.url_add_state, ca.zip, ca.state
    FROM campaign_stages s
    LEFT JOIN contact_attributes ca
      ON ca.contact_id = ${contactId} AND ca.org_id = ${orgId}
    WHERE s.id = ${stageId} AND s.org_id = ${orgId}
  `)) as unknown as {
    url_add_zip: boolean;
    url_add_state: boolean;
    zip: string | null;
    state: string | null;
  }[];
  const r = rows[0];
  if (!r) return NO_GEO;
  return { zip: r.url_add_zip ? r.zip : null, state: r.url_add_state ? r.state : null };
}

/** Test seam: swap the geo lookup (e.g. force a throw to prove fail-open). */
export interface ResolveClickDeps {
  lookupGeo: typeof lookupGeoParams;
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
  deps: ResolveClickDeps = { lookupGeo: lookupGeoParams },
): Promise<ResolveClickResult | null> {
  const lookup = (await dbc.execute(sql`
    SELECT l.id AS link_id, l.org_id AS org_id, d.url AS destination_url,
           l.send_token AS send_token, l.stage_id AS stage_id,
           l.contact_id AS contact_id
    FROM links l
    JOIN link_destinations d ON d.id = l.destination_id
    WHERE l.code = ${input.code}
    LIMIT 1
  `)) as unknown as {
    link_id: number;
    org_id: string;
    destination_url: string;
    send_token: string;
    stage_id: number;
    contact_id: string;
  }[];

  const row = lookup[0];
  if (!row) return null;

  // Append the per-recipient customer id (= send_token = stage_sends.id) as the
  // sub_id1 param so Keitaro can attribute a sale back to this exact recipient.
  // The shared per-stage destination is left untouched in link_destinations; the
  // recipient-specific param is added only here, at redirect time. appendUrlParam
  // is a no-op if the key is somehow already present. send_token is NOT NULL on
  // links, so every tracked link carries it.
  const withSubId1 = appendUrlParam(
    row.destination_url,
    RECIPIENT_SUB_ID_PARAM,
    row.send_token,
  );

  const classification = classifyClick(input.userAgent, input.prefetch);

  async function logClick(): Promise<void> {
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
  }

  // The geo lookup runs BESIDE the clicks insert, so it adds no round-trip of
  // its own; fail-open caps it at GEO_LOOKUP_BUDGET_MS. Flags off (every stage
  // before 0229 is used) ⇒ NO_GEO ⇒ the URL below is byte-identical to before.
  const [geo] = await Promise.all([
    lookupGeoParamsFailOpen(() =>
      deps.lookupGeo(dbc, row.org_id, Number(row.stage_id), row.contact_id),
    ),
    logClick(),
  ]);
  const destinationUrl = appendGeoParams(withSubId1, geo);

  return { destinationUrl, classification };
}
