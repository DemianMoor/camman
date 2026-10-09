import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { PARTNER_CAN_HAVE_LINK } from "@/lib/reporting/partner-report-token";

// The partner row and the key row as the Settings page sees them — ONE
// definition each, shared by /api/partners/* and /api/partner-keys (a Next.js
// route.ts may only export route fields, so these cannot live in a route).
//
// ⚠️ NEITHER SELECT EVER RETURNS `token`, `secret_hash` OR `report_token_hash`.
// The token is half a credential (shown once, then only on the key's own
// detail response to an admin); the secret and the link are hashed at rest and
// unrecoverable by design. "Is there a live link?" is all the UI needs.

export interface PartnerKeyJson {
  id: number;
  partner_id: number | null;
  partner_slug: string;
  name: string;
  interest_tag_mode: "force" | "default";
  interest_tag: string | null;
  field_mapping: Record<string, string>;
  sandbox: boolean;
  rate_per_sec: number;
  rate_per_day: number;
  max_payload_bytes: number;
  status: string;
  created_at: string;
  rotated_at: string | null;
  last_seen_at: string | null;
  secret_last4: string | null;
  leads_24h: number;
  auth_fails_today: number;
  total_leads: number;
}

export interface PartnerJson {
  id: number;
  slug: string;
  name: string;
  status: "active" | "archived";
  archived_at: string | null;
  created_at: string;
  /** Signed report link STATE only — never the hash. */
  report_link_active: boolean;
  report_token_issued_at: string | null;
  report_token_expires_at: string | null;
  report_show_revenue: boolean;
  /** Q7: no keys at all (file-only) OR at least one non-sandbox key. */
  can_have_link: boolean;
  keys: PartnerKeyJson[];
}

/** Key rows with usage, as `FROM partner_keys k …`; the caller appends WHERE / ORDER BY. */
export const KEY_LIST_SQL: SQL = sql`
    SELECT k.id, k.partner_id, k.partner_slug, k.name, k.interest_tag_mode, k.interest_tag,
           k.field_mapping, k.sandbox, k.rate_per_sec, k.rate_per_day,
           k.max_payload_bytes, k.status, k.created_at, k.rotated_at, k.last_seen_at,
           k.secret_last4,
           COALESCE(u.leads_24h, 0)::int   AS leads_24h,
           COALESCE(f.auth_fails_today, 0)::int AS auth_fails_today,
           COALESCE(l.total_leads, 0)::int AS total_leads
    FROM partner_keys k
    LEFT JOIN LATERAL (
      SELECT sum(count) AS leads_24h FROM partner_key_usage
      WHERE partner_key_id = k.id AND window_kind = 'day'
        AND window_start > now() - interval '24 hours'
    ) u ON true
    LEFT JOIN LATERAL (
      SELECT sum(count) AS auth_fails_today FROM partner_key_usage
      WHERE partner_key_id = k.id AND window_kind = 'auth_fail'
        AND window_start > now() - interval '24 hours'
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS total_leads FROM lead_inbox WHERE partner_key_id = k.id
    ) l ON true`;

/** Partner rows without their keys, as `FROM partners p …`; the caller appends WHERE / ORDER BY. */
export const PARTNER_ROW_SQL: SQL = sql`
    SELECT p.id, p.slug, p.name, p.status, p.archived_at, p.created_at,
           (p.report_token_hash IS NOT NULL) AS report_link_active,
           p.report_token_issued_at, p.report_token_expires_at, p.report_show_revenue,
           ${PARTNER_CAN_HAVE_LINK} AS can_have_link
    FROM partners p`;

type PartnerRowSql = Omit<PartnerJson, "keys">;

/** ONE partner with its keys, or null when it is not in this org. */
export async function loadPartner(orgId: string, partnerId: number): Promise<PartnerJson | null> {
  const ps = (await db.execute(sql`${PARTNER_ROW_SQL}
    WHERE p.id = ${partnerId} AND p.org_id = ${orgId}::uuid`)) as unknown as PartnerRowSql[];
  if (!ps[0]) return null;
  const ks = (await db.execute(sql`${KEY_LIST_SQL}
    WHERE k.partner_id = ${partnerId} AND k.org_id = ${orgId}::uuid
    ORDER BY (k.status = 'active') DESC, k.created_at`)) as unknown as PartnerKeyJson[];
  return { ...ps[0], keys: ks };
}

/** Every partner in the org with its keys, plus keys that have no partner yet (the C2 window). */
export async function listPartners(orgId: string): Promise<{ data: PartnerJson[]; unassigned_keys: PartnerKeyJson[] }> {
  const ps = (await db.execute(sql`${PARTNER_ROW_SQL}
    WHERE p.org_id = ${orgId}::uuid
    ORDER BY (p.status = 'active') DESC, p.slug`)) as unknown as PartnerRowSql[];
  const ks = (await db.execute(sql`${KEY_LIST_SQL}
    WHERE k.org_id = ${orgId}::uuid
    ORDER BY (k.status = 'active') DESC, k.created_at`)) as unknown as PartnerKeyJson[];
  const byPartner = new Map<number, PartnerKeyJson[]>();
  const unassigned: PartnerKeyJson[] = [];
  for (const k of ks) {
    if (k.partner_id == null) {
      unassigned.push(k);
      continue;
    }
    const list = byPartner.get(k.partner_id) ?? [];
    list.push(k);
    byPartner.set(k.partner_id, list);
  }
  return {
    data: ps.map((p) => ({ ...p, keys: byPartner.get(p.id) ?? [] })),
    // Shown, never hidden: a key created by pre-0200 code has no partner yet.
    unassigned_keys: unassigned,
  };
}
