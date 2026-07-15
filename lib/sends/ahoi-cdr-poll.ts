import { sql } from "drizzle-orm";
import Papa from "papaparse";
import { formatInTimeZone } from "date-fns-tz";

import type { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { CAMPAIGN_TIMEZONE, campaignDayBoundsUtc } from "@/lib/campaign-timezone";
import { processAhoiInboundOptOut } from "@/lib/sends/ahoi-optout";
import { ahoiBaseUrl } from "@/lib/sends/providers/ahoi";

// Rolling ET window (today + a midnight overlap — CDR timestamps are ET,
// Phase 0 recon). Reuses the project's single DST-safe day-boundary helper
// (campaignDayBoundsUtc) rather than a naive "now - 24h" subtraction: on a
// 25-hour fall-back day, subtracting a flat 24h from a moment just after
// ET-midnight can still land INSIDE today's ET date, not yesterday's. Going 1
// hour before today's ET-midnight boundary is always safely inside
// yesterday's calendar date instead (every ET day is at least 23h long).
export function computeCdrPollWindow(now: Date = new Date()): { startdate: string; enddate: string } {
  const enddate = formatInTimeZone(now, CAMPAIGN_TIMEZONE, "MM/dd/yyyy");
  const { start: todayStartUtc } = campaignDayBoundsUtc(now);
  const yesterdayInstant = new Date(todayStartUtc.getTime() - 60 * 60 * 1000);
  const startdate = formatInTimeZone(yesterdayInstant, CAMPAIGN_TIMEZONE, "MM/dd/yyyy");
  return { startdate, enddate };
}

export interface AhoiCdrRow {
  date: string;
  your_cost: string;
  submaster_id: string;
  user_id: string;
  submaster_cost: string;
  user_cost: string;
  surcharge: string;
  src: string;
  dst: string;
  message: string;
  direction: string;
  alpha: string;
  msg_type: string;
  uuid: string;
}

export type CdrFetchResult =
  | { ok: true; rows: AhoiCdrRow[] }
  | { ok: false; error: string };

export type CdrFetcher = (opts: {
  apiKey: string;
  startdate: string;
  enddate: string;
}) => Promise<CdrFetchResult>;

async function realFetchAhoiCdr(opts: {
  apiKey: string;
  startdate: string;
  enddate: string;
}): Promise<CdrFetchResult> {
  try {
    const url =
      `${ahoiBaseUrl()}/cdrs/download/csv?record_type=sms` +
      `&startdate=${encodeURIComponent(opts.startdate)}&enddate=${encodeURIComponent(opts.enddate)}` +
      `&key=${encodeURIComponent(opts.apiKey)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    const parsed = Papa.parse<AhoiCdrRow>(text, { header: true, skipEmptyLines: "greedy" });
    const rows = (parsed.data ?? []).filter((r) => r && typeof r === "object" && r.uuid);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
}

function parseCdrCost(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export interface AhoiCdrPollResult {
  credentials_polled: number;
  fetched: number; // total rows returned (all directions)
  inbound: number; // direction=in rows
  new: number; // newly captured
  dupe: number; // already-ingested (idempotent skip)
  error: string | null;
}

// Polls the Ahoi CDR system-of-record for every Ahoi credential (optionally
// scoped to one org), filters direction=in, and idempotently captures into
// ahoi_inbound_events (source='cdr') — a reconciliation backstop for the
// webhook (Task 6), NOT because the webhook is known lossy (Phase 0 recon:
// 0% webhook-layer loss measured; upstream-carrier loss is unrecoverable by
// either channel). dbc-parameterized so a test can pass a rolled-back tx.
export async function pollAhoiCdr(
  database: typeof db,
  opts?: { orgId?: string; fetchCdr?: CdrFetcher; now?: Date },
): Promise<AhoiCdrPollResult> {
  const fetchCdr = opts?.fetchCdr ?? realFetchAhoiCdr;
  const window = computeCdrPollWindow(opts?.now ?? new Date());
  const orgFilter = opts?.orgId ? sql`AND pc.org_id = ${opts.orgId}` : sql``;

  const creds = (await database.execute(sql`
    SELECT pc.id AS credential_id, pc.org_id AS org_id, pc.provider_id AS provider_id, pc.api_key AS api_key
    FROM provider_credentials pc
    JOIN sms_providers p ON p.id = pc.provider_id AND p.org_id = pc.org_id
    WHERE p.sms_provider_id = 'ahoi'
    ${orgFilter}
  `)) as unknown as { credential_id: number; org_id: string; provider_id: number; api_key: string }[];

  let fetched = 0;
  let inbound = 0;
  let neu = 0;
  let dupe = 0;
  let lastError: string | null = null;

  for (const cred of creds) {
    const res = await fetchCdr({ apiKey: cred.api_key, startdate: window.startdate, enddate: window.enddate });
    if (!res.ok) {
      lastError = res.error;
      await notifyTelegram(
        `⚠️ Ahoi CDR poll FAILED (inbound capture backstop down)\nerror: ${res.error}\ncredential: ${cred.credential_id}`,
      );
      continue;
    }
    fetched += res.rows.length;
    const inRows = res.rows.filter((r) => r.direction === "in");
    inbound += inRows.length;

    for (const r of inRows) {
      try {
        // Capture + process ATOMICALLY per row (unlike the webhook path,
        // which can't — a Next.js route handler using the `db` singleton has
        // no outer transaction to join). If processing throws, the capture
        // rolls back too, so the SAME provider_uuid is naturally re-fetched
        // and retried on the NEXT poll tick — the CDR channel's own
        // idempotent uuid-keyed capture becomes its own retry mechanism,
        // mirroring TextHub's per-message claim+process transaction in
        // lib/sends/poll-opt-outs.ts.
        const outcome = await database.transaction(async (tx) => {
          const inserted = (await tx.execute(sql`
            INSERT INTO ahoi_inbound_events
              (org_id, credential_id, provider_id, source, source_number, destination_number,
               message, type, cost, provider_uuid, method, raw_body)
            VALUES (${cred.org_id}, ${cred.credential_id}, ${cred.provider_id}, 'cdr', ${r.src}, ${r.dst},
                    ${r.message}, ${r.msg_type ?? null}, ${parseCdrCost(r.your_cost)}, ${r.uuid},
                    'poll', ${JSON.stringify(r)})
            ON CONFLICT (provider_id, provider_uuid) WHERE provider_uuid IS NOT NULL DO NOTHING
            RETURNING id
          `)) as unknown as { id: string }[];
          if (inserted.length === 0) return "dupe" as const;

          // Layer 2 (spec §6): same processing core Layer 1 uses, tagged
          // ahoi_cdr. CARRY 1's cross-channel dedup lives inside this call.
          await processAhoiInboundOptOut(tx, {
            eventId: inserted[0]!.id,
            orgId: cred.org_id,
            sourceNumber: r.src,
            message: r.message,
            optOutSource: "ahoi_cdr",
            receivedAt: new Date(),
          });
          return "new" as const;
        });
        if (outcome === "dupe") dupe++; else neu++;
      } catch (e) {
        console.error("[ahoi-cdr-poll] row processing failed, will retry next poll:", e);
      }
    }
  }

  return { credentials_polled: creds.length, fetched, inbound, new: neu, dupe, error: lastError };
}
