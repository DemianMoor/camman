// scripts/_drip-hourly-fixture.ts — throwaway org for hourly-cap tests. Preview DB only.
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { createPartnerWithKey } from "./_partner-fixture";

export const MARKER = "__DRIP_HOURLY_TEST__";
const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];

export async function makeFixture() {
  const sfx = String(Date.now()).slice(-7);
  const orgId = (await one<{ id: string }>(
    sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${sfx}`}) RETURNING id`)).id;
  async function teardown(): Promise<number> {
    const name = (await one<{ name: string } | undefined>(
      sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
    if (!name.includes(MARKER)) throw new Error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
    await db.execute(sql`DELETE FROM drip_journeys WHERE org_id = ${orgId}::uuid`);
    await db.execute(sql`DELETE FROM lead_events WHERE org_id = ${orgId}::uuid`);
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    const left = await one<{ n: string }>(sql`
      SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId}::uuid)
            + (SELECT count(*) FROM drip_journeys WHERE org_id = ${orgId}::uuid)
            + (SELECT count(*) FROM campaigns WHERE org_id = ${orgId}::uuid)
            + (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid)) AS n`);
    return Number(left.n);
  }

  try {
    await db.execute(sql`
      INSERT INTO org_settings (org_id, drip_enabled, drip_paused, drip_hourly_cap_enabled)
      VALUES (${orgId}::uuid, true, false, true)
      ON CONFLICT (org_id) DO UPDATE SET drip_enabled = true, drip_paused = false, drip_hourly_cap_enabled = true`);
    const keyId = (await createPartnerWithKey(db, { orgId, slug: "hc-" + sfx, name: "hc", token: "tokhc" + sfx })).keyId;
    let seq = 0;

    /** Active drip campaign with one first-send stage 09:00–18:00 ET. */
    async function campaign(tag: string, cap: number | null, carry: boolean, withCreative = true) {
      const id = (await one<{ id: number }>(sql`
        INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
        VALUES (${orgId}::uuid, ${`hc-${sfx}-${tag}`}, ${`HC ${tag}`}, 'active', 'drip', 'tracked') RETURNING id`)).id;
      await db.execute(sql`
        INSERT INTO drip_campaign_configs (campaign_id, org_id, interest_tag, hourly_cap, hourly_carry)
        VALUES (${id}, ${orgId}::uuid, ${"hc" + tag}, ${cap}, ${carry})`);
      const creativeId = withCreative
        ? (await one<{ id: number }>(sql`
            INSERT INTO creatives (org_id, slug, text, status)
            VALUES (${orgId}::uuid, ${`hc-cr-${sfx}-${tag}`}, 'Hi from the hourly-cap test', 'active') RETURNING id`)).id
        : null;
      await db.execute(sql`
        INSERT INTO campaign_stages (org_id, campaign_id, stage_number, drip_active, window_start_min, window_end_min, creative_id)
        VALUES (${orgId}::uuid, ${id}, 1, true, 540, 1080, ${creativeId})`);
      return id;
    }

    /** n routed journeys at explicit instants (1 s apart from `at`). Returns ids oldest first. */
    async function journeys(campaignId: number, n: number, at: Date, extra: SQL = sql``): Promise<string[]> {
      const base = seq; seq += n;
      const rows = (await db.execute(sql`
        WITH c AS (
          INSERT INTO contacts (org_id, phone_number)
          SELECT ${orgId}::uuid, '+1997' || ${sfx} || lpad((${base} + g)::text, 4, '0') FROM generate_series(1, ${n}) g
          RETURNING id
        ), e AS (
          INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at)
          SELECT ${orgId}::uuid, c.id, ${keyId}, ${"hc-" + sfx}, ${at.toISOString()}::timestamptz FROM c
          RETURNING id, contact_id
        )
        INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state, routed_at)
        SELECT ${orgId}::uuid, ${campaignId}, e.contact_id, e.id, 'routed',
               ${at.toISOString()}::timestamptz + make_interval(secs => row_number() OVER (ORDER BY e.id))
        FROM e
        RETURNING id, routed_at ${extra}`)) as unknown as { id: string; routed_at: string }[];
      return rows.sort((a, b) => +new Date(a.routed_at) - +new Date(b.routed_at)).map((r) => r.id);
    }

    /** Mark journeys as first-sent at `at` (no stage_sends needed for counting). */
    async function markSent(ids: string[], at: Date) {
      await db.execute(sql`
        UPDATE drip_journeys SET state = 'active', first_send_at = ${at.toISOString()}::timestamptz
        WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])`);
    }

    async function states(ids: string[]) {
      return (await db.execute(sql`
        SELECT id, state, close_reason, hour_start, hour_fresh, reason
        FROM drip_journeys WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])`)) as unknown as {
        id: string; state: string; close_reason: string | null; hour_start: string | null;
        hour_fresh: boolean | null; reason: Record<string, unknown> | null;
      }[];
    }


    return { orgId, campaign, journeys, markSent, states, teardown };
  } catch (e) {
    // Setup failed after the org insert: tear down what exists, then rethrow.
    await teardown().catch(() => undefined);
    throw e;
  }
}
