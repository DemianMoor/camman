import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/intake/partner-key";

// Since 0200 a key belongs to a partner and since 0201 that is NOT NULL, so a
// fixture that inserts a key must create (or reuse) its partner first. One
// helper, so the key-inserting scripts cannot drift on the column list again.
//
// Reuses an existing partner with the same (org, slug) — a fixture script that
// runs twice in one database must not trip partners_org_slug_uniq.
export async function createPartnerWithKey(
  tx: DbOrTx,
  o: {
    orgId: string;
    slug: string;
    name?: string;
    token?: string;
    secretHash?: string;
    sandbox?: boolean;
    status?: "active" | "disabled";
    interestTagMode?: "force" | "default";
    interestTag?: string | null;
    ratePerSec?: number;
    ratePerDay?: number;
    maxPayloadBytes?: number;
  },
): Promise<{ partnerId: number; keyId: number; token: string }> {
  const p = (await tx.execute(sql`
    INSERT INTO partners (org_id, slug, name) VALUES (${o.orgId}::uuid, ${o.slug}, ${o.name ?? o.slug})
    ON CONFLICT (org_id, slug) DO UPDATE SET name = partners.name
    RETURNING id`)) as unknown as { id: number }[];
  const token = o.token ?? `tok-${o.slug}-${Math.random().toString(36).slice(2, 8)}`;
  const k = (await tx.execute(sql`
    INSERT INTO partner_keys (org_id, partner_id, partner_slug, name, token, secret_hash, sandbox, status,
                              interest_tag_mode, interest_tag, rate_per_sec, rate_per_day, max_payload_bytes)
    VALUES (${o.orgId}::uuid, ${p[0].id}, ${o.slug}, ${o.name ?? o.slug}, ${token}, ${o.secretHash ?? "h"},
            ${o.sandbox ?? true}, ${o.status ?? "active"}, ${o.interestTagMode ?? "default"}, ${o.interestTag ?? null},
            ${o.ratePerSec ?? 10}, ${o.ratePerDay ?? 50000}, ${o.maxPayloadBytes ?? 262144})
    RETURNING id`)) as unknown as { id: number }[];
  return { partnerId: p[0].id, keyId: k[0].id, token };
}
