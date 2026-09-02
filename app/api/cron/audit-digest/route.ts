import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { organizations } from "@/db/schema";
import { buildAndSendAuditDigest } from "@/lib/alerts/audit-digest";

// Daily audit digest cron (869et3vm1 Phase 4).
//
// Auth: Authorization: Bearer ${CRON_SECRET} (or x-cron-secret), matching every
// other cron in this app.
//
// ⚠️ OFF THE SEND PATH. It reads audit_log and deletion_requests only — never
// stage_sends, materialize or the drain. Scheduled at 09:00 ET (13:00 UTC), i.e.
// after the previous ET day has closed, so the window it reports is complete.
//
// ?test=1 sends the digest regardless of schedule, for verification.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // One digest per org. Single-org today, but looping costs nothing and means
  // a second org does not silently go unreported.
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  const results: Record<string, unknown>[] = [];
  for (const o of orgs) {
    try {
      const r = await buildAndSendAuditDigest(o.id);
      results.push({ org_id: o.id, ...r });
    } catch (err) {
      // One org failing must not stop the others.
      console.error("[audit-digest] failed for org", o.id, err);
      results.push({ org_id: o.id, sent: false, error: String(err) });
    }
  }

  return NextResponse.json({ orgs: orgs.length, results });
}
