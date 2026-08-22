import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { notifyOnTransition } from "@/lib/alerts/alert-state";
import { captureLeads, prepareLead } from "@/lib/intake/capture";
import { MAX_LEADS_PER_CALL } from "@/lib/intake/fields";
import { resolvePartnerKey, secretMatches, touchLastSeen } from "@/lib/intake/partner-key";
import { consume, recordAuthFailure } from "@/lib/intake/rate-limit";

// Partner lead intake — Drip Phase 2. ZERO SENDS, ZERO PROCESSING.
//
// The FIFTH instance of the webhook auth pattern the four provider webhooks
// already use (see Q7 of the Phase 0 recon; app/api/webhooks/tells/inbound is
// the reference). The sequence is deliberately identical where it can be:
//
//   1. opaque path token -> partner_keys row; unresolved => 401, LOG ONLY
//   2. second factor: the secret, constant-time compared against secret_hash
//   3. Content-Length cap BEFORE the body is read
//   4. DB-backed rate limit (per-second on requests, per-ET-day on leads)
//   5. validate shape; store everything, including what fails
//   6. ONE committed INSERT carrying a dedup key; return 202
//
// What is deliberately ABSENT versus the Tells reference: step 5's "best-effort
// inline processing". Phase 2 processes nothing at all — `status='received'` IS
// the queue, and Phase 3 supplies the consumer. Keeping the handler at two
// round trips is also what makes the 50 req/s burst target trivial.
//
// force-dynamic: every partner POST must run and be recorded, never cached.
export const dynamic = "force-dynamic";

function jsonError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token) return new NextResponse("Not found", { status: 404 });

  const key = await resolvePartnerKey(db, token);
  if (!key) {
    // ⚠️ LOG ONLY, NEVER ALERT (ruling G18). A public intake URL is scanned
    // continuously; alerting here would page someone forever and train them to
    // ignore it. An unresolved token also writes NOTHING — a scanner must not
    // be able to create rows. The alertable event is the opposite case below:
    // a token that DOES resolve with a secret that does not match, which means
    // a rotated or leaked credential.
    console.warn(`[intake] unresolved token (prefix=${token.slice(0, 6)})`);
    return jsonError(401, "Unauthorized");
  }
  if (key.status !== "active") {
    // Distinct from an unknown token on purpose: the partner needs to know
    // their key was disabled rather than mistyped.
    return jsonError(403, "This partner key is disabled");
  }

  // ---- second factor: the secret (header only, ruling G12) ----------------
  // Header, not body: the secret is then STRUCTURALLY absent from the payload
  // we persist, so redaction is not a string edit that can be got wrong. This
  // is the one place we improve on the Tells reference, which only carries its
  // key in the body because Tells chose that.
  const auth = req.headers.get("authorization");
  const supplied =
    req.headers.get("x-partner-secret") ??
    (auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null);

  if (!secretMatches(supplied, key.secret_hash)) {
    const failures = await recordAuthFailure(db, {
      orgId: key.org_id,
      partnerKeyId: key.id,
    }).catch(() => 0);
    console.error(
      `[intake] SECRET MISMATCH on a resolved token (partner=${key.partner_slug} key=${key.id}) ` +
        `failures_today=${failures}`,
    );
    // State-transition gated: fires once when the condition starts, then stays
    // silent while it persists. Threshold, not first failure — a single typo
    // during partner onboarding is not worth a page.
    if (failures >= 5) {
      void notifyOnTransition(db, {
        alertKey: `intake:auth_fail:${key.id}`,
        orgId: key.org_id,
        text:
          `🚨 Partner intake: ${failures} failed secret checks today on a RESOLVED token ` +
          `for "${key.partner_slug}" (key ${key.id}). The token is valid but the secret is ` +
          `not — check whether the secret was rotated without telling the partner, or leaked.`,
      });
    }
    return jsonError(401, "Unauthorized");
  }

  // ---- payload size cap, BEFORE reading the body -------------------------
  // Nothing in this repo checked Content-Length before Phase 2. App Router
  // handlers have no default body cap; the only other ceiling is Vercel's
  // platform limit (~4.5 MB), which is far too high to be a partner contract.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > key.max_payload_bytes) {
    return jsonError(413, "Payload too large", {
      max_payload_bytes: key.max_payload_bytes,
      received_bytes: declared,
    });
  }

  let body: unknown;
  try {
    const text = await req.text();
    // A chunked request may omit Content-Length, so re-check what actually
    // arrived. Byte length, not string length — multi-byte characters would
    // otherwise let a payload past a cap expressed in bytes.
    const actual = Buffer.byteLength(text, "utf8");
    if (actual > key.max_payload_bytes) {
      return jsonError(413, "Payload too large", {
        max_payload_bytes: key.max_payload_bytes,
        received_bytes: actual,
      });
    }
    body = JSON.parse(text);
  } catch {
    return jsonError(400, "Body must be valid JSON");
  }

  const leadsIn = Array.isArray(body) ? body : [body];
  if (leadsIn.length === 0) return jsonError(400, "No leads in payload");
  if (leadsIn.length > MAX_LEADS_PER_CALL) {
    return jsonError(413, "Too many leads in one call", {
      max_leads_per_call: MAX_LEADS_PER_CALL,
      received: leadsIn.length,
    });
  }
  // ⚠️ Load-bearing pre-check, not defensive noise. The limiter's guard lives on
  // the ON CONFLICT DO UPDATE, so the INSERT branch — the first call of a
  // window — is NOT guarded. Without this, one oversized batch would be
  // admitted on a cold window. Asserted in scripts/test-intake-schema.ts.
  if (leadsIn.length > key.rate_per_day) {
    return jsonError(413, "Batch exceeds this key's daily limit", {
      rate_per_day: key.rate_per_day,
      received: leadsIn.length,
    });
  }

  // ---- rate limits (G14: per-second counts REQUESTS, per-day counts LEADS) --
  const perSec = await consume(db, {
    orgId: key.org_id,
    partnerKeyId: key.id,
    window: "sec",
    limit: key.rate_per_sec,
    n: 1,
  });
  if (!perSec.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded", limit: key.rate_per_sec, window: "second" },
      { status: 429, headers: { "Retry-After": String(perSec.retryAfterSeconds) } },
    );
  }

  // Whole-batch refusal (ruling G15): nothing is stored if the day's budget
  // cannot take all of it. Partial acceptance would leave the partner unable to
  // tell which leads landed, making their retry ambiguous.
  const perDay = await consume(db, {
    orgId: key.org_id,
    partnerKeyId: key.id,
    window: "day",
    limit: key.rate_per_day,
    n: leadsIn.length,
  });
  if (!perDay.allowed) {
    return NextResponse.json(
      {
        error: "Daily lead limit exceeded",
        limit: key.rate_per_day,
        window: "day",
        leads_in_call: leadsIn.length,
      },
      { status: 429, headers: { "Retry-After": String(perDay.retryAfterSeconds) } },
    );
  }

  // ---- validate + capture -------------------------------------------------
  const receivedAt = new Date();
  const prepared = leadsIn.map((l) => prepareLead(l, key, receivedAt));

  let results;
  try {
    results = await captureLeads(db, {
      orgId: key.org_id,
      partnerKeyId: key.id,
      partnerSlug: key.partner_slug,
      sandbox: key.sandbox,
      leads: prepared,
      receivedAt,
    });
  } catch (err) {
    // Unlike the Tells STOP path, a failed capture here is NOT a compliance
    // incident — the partner will retry and nothing has been suppressed. 500 so
    // they DO retry, rather than acking a lead we did not store.
    console.error(`[intake] CAPTURE FAILED for partner ${key.partner_slug}`, err);
    return jsonError(500, "Capture failed");
  }

  void touchLastSeen(db, key.id).catch(() => {});

  const accepted = results.filter((r) => r.status === "received" && !r.duplicate).length;
  const duplicates = results.filter((r) => r.duplicate).length;
  const rejected = results.filter((r) => r.status === "rejected").length;

  return NextResponse.json(
    {
      accepted,
      duplicates,
      rejected,
      sandbox: key.sandbox,
      // Ids in the caller's original order, so a partner can reconcile by index.
      leads: results.map((r, i) => ({
        id: r.id,
        status: r.status,
        duplicate: r.duplicate,
        ...(prepared[i].error ? { error: prepared[i].error } : {}),
      })),
    },
    { status: 202 },
  );
}
