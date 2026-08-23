import { sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { evaluateLeadRouting } from "@/lib/drip/routing-eval";
import { can } from "@/lib/permissions";
import { validatePhone } from "@/lib/phone-validation";

// "Why was this number not routed?" — the drip debugging tool (Phase 4).
//
// ⭐ IT CALLS THE SAME EVALUATOR THE ROUTER CALLS. That is the entire point. A
// separate explain-path would be a second implementation of the eligibility
// rules, and the first time the two drifted this endpoint would confidently
// explain a decision the router never made. An operator on the phone to a
// partner asking "why did none of my 4,000 leads send?" cannot afford a
// plausible lie — they need the actual rule that actually fired.
//
// Read-only: evaluateLeadRouting writes nothing, so this can be run against an
// already-routed lead, an unroutable one, or one still waiting.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "campaigns.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const raw = req.nextUrl.searchParams.get("phone")?.trim() ?? "";
  if (!raw) {
    return apiError(400, "phone is required", API_ERROR_CODES.VALIDATION, { field: "phone" });
  }
  const parsed = validatePhone(raw);
  if (!parsed.valid || !parsed.normalized) {
    return apiError(400, `Could not parse that number: ${parsed.error ?? "invalid"}`,
      API_ERROR_CODES.VALIDATION, { field: "phone" });
  }
  const phone = parsed.normalized;

  const contact = await db.execute(drizzleSql`
    SELECT id, created_at, carrier_norm, line_type, messaging_status
    FROM contacts WHERE org_id = ${orgId}::uuid AND phone_number = ${phone} LIMIT 1
  `);
  if (!contact[0]) {
    // A genuinely useful distinct answer: the number never became a contact, so
    // the question is about INTAKE or ENRICHMENT, not routing.
    const inbox = await db.execute(drizzleSql`
      SELECT status, error, received_at, sandbox FROM lead_inbox
      WHERE org_id = ${orgId}::uuid AND phone_e164 = ${phone}
      ORDER BY received_at DESC LIMIT 5
    `);
    return NextResponse.json({
      phone,
      found: false,
      stage: inbox.length > 0 ? "stuck_before_contact" : "never_seen",
      explanation:
        inbox.length > 0
          ? "This number reached the inbox but never became a contact — look at the inbox rows below (landlines are counted and removed, rejects keep their error)."
          : "This number has never been seen by intake at all. Check the partner is posting it, and that the key is not in sandbox.",
      inbox,
    });
  }

  const events = await db.execute(drizzleSql`
    SELECT e.id, e.received_at, e.interest_tag, e.partner_slug, e.sandbox, e.line_type,
           j.id AS journey_id, j.state AS journey_state, j.campaign_id, j.reason
    FROM lead_events e
    LEFT JOIN drip_journeys j ON j.lead_event_id = e.id
    WHERE e.org_id = ${orgId}::uuid AND e.contact_id = ${contact[0].id}
    ORDER BY e.received_at DESC
    LIMIT 20
  `) as unknown as Record<string, unknown>[];

  if (events.length === 0) {
    return NextResponse.json({
      phone, found: true, contact: contact[0], stage: "contact_without_lead_event",
      explanation:
        "This contact exists but has no drip lead event — it came from a CSV upload or another path, not from partner intake, so drip routing never considered it.",
      events: [],
    });
  }

  // Explain the most recent arrival — live, against today's campaigns.
  const latest = events[0] as { id: string };
  const verdict = await evaluateLeadRouting(db, { orgId, leadEventId: latest.id });

  return NextResponse.json({
    phone,
    found: true,
    contact: contact[0],
    stage: "evaluated",
    // ⚠️ Recomputed NOW, against today's campaigns and caps — so it can
    // legitimately differ from the stored `reason` on an existing journey, which
    // records what was true at routing time. Both are shown, and the difference
    // is usually the answer.
    live_evaluation: verdict,
    stored_journeys: events.filter((e) => e.journey_id !== null),
    events,
  });
}
