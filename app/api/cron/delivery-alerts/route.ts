import { sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { notifyOnTransition } from "@/lib/alerts/alert-state";
import {
  findLowDeliveryStages,
  formatLowDeliveryAlert,
  lowDeliveryAlertKey,
} from "@/lib/reporting/low-delivery-alert";

// Low-delivery Telegram alert: a stage whose sends are ≥ 60 min old and below
// 70% delivered pages once, with the error codes. Logic in
// lib/reporting/low-delivery-alert.ts; per-org switch
// notification_settings.delivery_alert_enabled (0236, default on).
//
// Every 10 min at :07/:17/… (vercel.json), off the */5 send marks. Latched
// through alert_state: a regular stage alerts once ever, a drip stage once per
// ET day. Nothing clears the latch — a stage that recovers doesn't re-page.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const orgs = (await db.execute(sql`
    SELECT o.id AS org_id
    FROM public.organizations o
    LEFT JOIN public.notification_settings ns ON ns.org_id = o.id
    WHERE COALESCE(ns.delivery_alert_enabled, true)
  `)) as unknown as { org_id: string }[];

  const results: { org_id: string; breached_stage_ids?: number[]; error?: string }[] = [];
  for (const { org_id } of orgs) {
    try {
      const breaches = await findLowDeliveryStages(db, org_id, now);
      for (const b of breaches) {
        // Best-effort and self-swallowing; retries on later ticks until
        // Telegram confirms delivery.
        await notifyOnTransition(db, {
          alertKey: lowDeliveryAlertKey(b.stage_id, b.is_drip, now),
          orgId: org_id,
          text: formatLowDeliveryAlert(b),
        });
      }
      results.push({ org_id, breached_stage_ids: breaches.map((b) => b.stage_id) });
    } catch (err) {
      console.error(`[delivery-alerts] org ${org_id} failed:`, err);
      results.push({ org_id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({ checked_at: now.toISOString(), results });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
