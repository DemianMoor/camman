import { sql } from "drizzle-orm";

import { ahoiSourceToE164 } from "@/lib/sends/providers/ahoi";
import { latestSendForAttribution } from "@/lib/sends/poll-opt-outs";
import { recomputeStageTotalCost } from "@/lib/stages/total-cost";
import type { DbOrTx } from "@/lib/sends/ahoi-dlr";

// G4/O1: NO Ahoi opt-out-error DLR signature has been confirmed live —
// Phase 0 recon + Section 3 only ever observed carrier_sent/delivered with
// error=000 on success; the doc-inferred `rejected`/error=600 shape has
// never actually been seen and only describes generic rejection, not
// specifically "recipient sent MO STOP" (Ahoi does not even enforce
// opt-out suppression on its own platform — recon). This allowlist
// therefore ships EMPTY: Layer 3 exists end-to-end (wired, tested via the
// `knownCodes` seam below) but will not classify anything as an opt-out in
// production until a human adds a real code here after seeing one in the
// [ahoi-dlr-optout] distinct-log lines (processAhoiDlrOptOut, below) and
// confirming it against a real MO STOP. Keys are lowercase-trimmed `error`
// OR `smpp_code` values.
//
// ⚠️ WHEN ACTIVATING (adding a real code here): the DLR route currently calls
// processAhoiDlrOptOut on the `db` singleton (harmless while this set is empty
// — it returns before any write). Once a code can match, that call performs a
// multi-statement write (contact → opt_out → attribution → counters) and MUST
// be wrapped in `db.transaction(tx => processAhoiDlrOptOut(tx, …))` — matching
// the inbound-webhook path — so a partial failure can't leave a half-written
// opt_out. Do not activate a code without also wrapping the route call.
export const AHOI_KNOWN_OPTOUT_DLR_CODES: ReadonlySet<string> = new Set([]);

export function classifyAhoiDlrOptOut(
  dlr: { sendStatus: string; error: string | null; smppCode: string | null },
  knownCodes: ReadonlySet<string> = AHOI_KNOWN_OPTOUT_DLR_CODES,
): boolean {
  if (dlr.sendStatus !== "rejected") return false;
  const err = dlr.error?.trim().toLowerCase();
  const code = dlr.smppCode?.trim().toLowerCase();
  return (!!err && knownCodes.has(err)) || (!!code && knownCodes.has(code));
}

export interface ProcessAhoiDlrOptOutOpts {
  orgId: string;
  // 10-digit RECIPIENT number — the DLR's `destination` field. Opposite of
  // ahoi_inbound_events, where `source` is the recipient; here WE are the
  // SMPP-sense "source" (our sending number) and the recipient is
  // `destination`. Passed by the DLR route from extractAhoiWebhookFields's
  // `fields.destination` (DlrEvent itself doesn't carry it — see
  // lib/sends/ahoi-dlr.ts's capture code for the same pattern).
  destinationNumber: string | null;
  sendStatus: string;
  error: string | null;
  smppCode: string | null;
  receivedAt: Date;
  // Test seam ONLY — production call sites never pass this, so they always
  // get the real (today empty) AHOI_KNOWN_OPTOUT_DLR_CODES default. Lets the
  // go-live harness (Task 7) prove the PIPELINE works without a real Ahoi
  // code, which does not exist yet (O1).
  knownCodes?: ReadonlySet<string>;
}

export type ProcessAhoiDlrOptOutOutcome =
  | { kind: "not_opt_out" }
  | { kind: "invalid_phone" }
  | { kind: "suppressed"; contactId: string; attributed: boolean };

// Layer 3 (spec §6). Deliberately does NOT apply CARRY 1's cross-channel
// dedup — that machinery targets the SAME physical inbound message arriving
// via two channels (ahoi_inbound_events rows), whereas a DLR reject is a
// structurally different, outbound-side signal with no ahoi_inbound_events
// row of its own to dedup against. Scoping rationale is in the Section 4
// plan's "Boundary" section — accepted as a documented, low-probability gap
// (Layer 3 ships defensively empty today and cannot fire in production yet).
export async function processAhoiDlrOptOut(
  dbc: DbOrTx,
  o: ProcessAhoiDlrOptOutOpts,
): Promise<ProcessAhoiDlrOptOutOutcome> {
  const isOptOut = classifyAhoiDlrOptOut({ sendStatus: o.sendStatus, error: o.error, smppCode: o.smppCode }, o.knownCodes);

  if (o.sendStatus === "rejected") {
    // G4: every rejected DLR gets a DISTINCT log line with its error/smpp_code
    // so the real opt-out signature is spottable the first time Ahoi's
    // platform actually emits one (O1) — separate from Section 3's "unmapped
    // send_status" log in reconcileAhoiDlrEvent (which only fires for
    // statuses OTHER than carrier_sent/delivered/rejected — 'rejected'
    // itself is already a KNOWN send_status, just not yet resolved to a
    // specific REASON).
    if (isOptOut) {
      console.warn(
        `[ahoi-dlr-optout] recognized opt-out DLR code (error="${o.error ?? ""}", smpp_code="${o.smppCode ?? ""}") -> suppressing ${o.destinationNumber}`,
      );
    } else {
      console.warn(
        `[ahoi-dlr-optout] unmapped reject code (error="${o.error ?? ""}", smpp_code="${o.smppCode ?? ""}") — not classified as opt-out (add to AHOI_KNOWN_OPTOUT_DLR_CODES if this is the opt-out signature)`,
      );
    }
  }

  if (!isOptOut) {
    return { kind: "not_opt_out" };
  }

  const phone = o.destinationNumber ? ahoiSourceToE164(o.destinationNumber) : null;
  if (!phone) return { kind: "invalid_phone" };

  const c = (await dbc.execute(sql`
    INSERT INTO contacts (org_id, phone_number)
    VALUES (${o.orgId}, ${phone})
    ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now()
    RETURNING id
  `)) as unknown as { id: string }[];
  const contactId = c[0]!.id;

  const anchorIso = o.receivedAt.toISOString();
  const oo = (await dbc.execute(sql`
    INSERT INTO opt_outs (org_id, contact_id, phone_number, source, created_at)
    VALUES (${o.orgId}, ${contactId}, ${phone}, 'ahoi_dlr_optout', ${anchorIso}::timestamptz)
    RETURNING id
  `)) as unknown as { id: number }[];
  const optOutId = oo[0]!.id;

  const match = await latestSendForAttribution(dbc, o.orgId, phone, anchorIso);
  let attributed = false;
  if (match) {
    const ins = (await dbc.execute(sql`
      INSERT INTO opt_out_attributions (org_id, opt_out_id, stage_send_id, stage_id, campaign_id, created_at)
      VALUES (${o.orgId}, ${optOutId}, ${match.stage_send_id}, ${match.stage_id}, ${match.campaign_id}, ${anchorIso}::timestamptz)
      ON CONFLICT (opt_out_id, stage_id) DO NOTHING
      RETURNING id
    `)) as unknown as { id: number }[];
    if (ins.length > 0) {
      attributed = true;
      await dbc.execute(sql`
        UPDATE campaign_stages
        SET inbound_opt_out_count = inbound_opt_out_count + 1,
            opt_out_count = inbound_opt_out_count + 1
        WHERE id = ${match.stage_id}
      `);
      await recomputeStageTotalCost(dbc, match.stage_id);
    }
  }

  return { kind: "suppressed", contactId, attributed };
}
