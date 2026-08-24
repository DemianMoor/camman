import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  normalizeBool,
  normalizeDob,
  normalizeEmail,
  normalizeGender,
  normalizeIncomeBand,
} from "@/lib/contact-attributes";
import { extractLeadFields } from "@/lib/intake/fields";
import { enqueueNormalized } from "@/lib/telnyx/enqueue";
import { bumpIntakeCounters, counterForLineType, etDay } from "./counters";
import { addContactsToGroup, ensureDripGroup } from "./groups";
import { dripLookupBudget } from "./lookup-guard";

// The lead_inbox consumer (Drip Phase 3). ZERO SENDS.
//
// ⭐ WHY TWO PASSES. The Telnyx lookup worker is a synchronous POLL — it claims
// from lookup_queue and calls Telnyx inline (lib/telnyx/worker.ts) — so there is
// no callback to receive and no way to block on a result inside one tick.
// Pass 1 normalizes and either finalizes (cache hit) or parks the lead in
// `awaiting_lookup` after enqueuing it. Pass 2 picks up parked leads whose
// result has since landed. Both run in the same invocation, so a cache hit is
// same-pass and a miss resolves on a later tick.
//
// ⭐ NO SECOND LOOKUP PATH. Drip enqueues through the existing
// `enqueueNormalized`, which already does cache-hit detection and ledger
// writing. The only drip-specific thing is the queue PRIORITY (migration 0158):
// the queue is account-global and FIFO, so without it one bulk upload starves
// every drip lead for up to 111 minutes (measured p95).
//
// ⭐ EVERY LEAD ENDS IN A TERMINAL STATE OR STAYS CLAIMABLE. There is no path
// that leaves a row neither processed nor retryable — the batch is claimed
// `FOR UPDATE SKIP LOCKED` inside one transaction, and the status write is the
// commit point.

const BATCH_SIZE = 200;

export interface EnrichmentResult {
  claimed: number;
  processed: number;
  landline: number;
  awaitingLookup: number;
  /** Left as 'received' because the drip daily sub-cap was exhausted. */
  capDeferred: number;
  rejected: number;
  lookupsEnqueued: number;
  capReached: boolean;
}

interface InboxRow {
  id: string;
  org_id: string;
  partner_key_id: number;
  partner_slug: string;
  raw: Record<string, unknown>;
  phone_e164: string | null;
  interest_tag: string | null;
  sandbox: boolean;
  received_at: string;
  status: string;
  field_mapping: Record<string, string> | null;
  line_type: string | null;
  lookup_complete: boolean;
}

/**
 * Build the `normalized` JSONB from the raw payload.
 *
 * Reuses the 1c normalizers verbatim — including `normalizeDob`, which maps the
 * 1970-01-01 epoch placeholder to NULL. That one matters: storing it would
 * manufacture a 56-year-old cohort out of blanks, and an age band is a
 * targeting filter.
 *
 * Only non-null results are emitted, so the attribute upsert's
 * COALESCE(EXCLUDED.x, existing) can never blank a value we already knew.
 */
export function normalizeLead(
  raw: Record<string, unknown>,
  mapping: Record<string, string>,
): Record<string, unknown> {
  const f = extractLeadFields(raw, mapping);
  const str = (v: unknown) => {
    const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
    return s.length > 0 ? s : null;
  };

  const out: Record<string, unknown> = {
    first_name: str(f.first_name),
    last_name: str(f.last_name),
    address: str(f.address),
    state: str(f.state),
    country: str(f.country),
    email: normalizeEmail(str(f.email)),
    gender: normalizeGender(str(f.gender)),
    income_band: normalizeIncomeBand(str(f.income_band)),
    dob: normalizeDob(str(f.dob)),
    kids: normalizeBool(str(f.kids)),
    married: normalizeBool(str(f.married)),
  };
  for (const k of Object.keys(out)) if (out[k] === null || out[k] === undefined) delete out[k];
  return out;
}

/** Claim a batch and drive every row to its next state. One transaction. */
export async function runEnrichmentBatch(now: Date = new Date()): Promise<EnrichmentResult> {
  const res: EnrichmentResult = {
    claimed: 0, processed: 0, landline: 0, awaitingLookup: 0, capDeferred: 0,
    rejected: 0, lookupsEnqueued: 0, capReached: false,
  };

  // Numbers needing a Telnyx call, collected inside the transaction and
  // enqueued AFTER it commits — enqueueNormalized opens its own transaction,
  // and nesting it inside this one would hold the claim open across an
  // unrelated write path.
  //
  // ⚠️ Kept PER PARTNER KEY, not as one flat list. lead_intake_daily's key is
  // (partner_key_id, day_et), so attributing spend by org would either update
  // the wrong partner's row or none at all when a batch spans two partners.
  // ⚠️ KEYED BY PARTNER **AND TAG** (Drip P7). The report is per partner x tag,
  // so bucketing by partner alone would put every lookup under "(untagged)" and
  // show zero lookup cost against the tagged rows an invoice is built from.
  const toEnqueue = {
    orgId: "",
    byKey: new Map<string, { partnerKeyId: number; tag: string; phones: string[] }>(),
  };

  await db.transaction(async (tx) => {
    // Claim: 'received' (pass 1) and 'awaiting_lookup' whose result has landed
    // (pass 2), oldest first. SKIP LOCKED so a slow batch never blocks the next
    // tick, and the lease already guarantees a single runner anyway.
    const rows = (await tx.execute(sql`
      SELECT li.id, li.org_id, li.partner_key_id, li.partner_slug, li.raw, li.phone_e164,
             li.interest_tag, li.sandbox, li.received_at, li.status,
             pk.field_mapping,
             pl.line_type,
             (pl.lookup_status = 'complete') AS lookup_complete
      FROM lead_inbox li
      JOIN partner_keys pk ON pk.id = li.partner_key_id
      LEFT JOIN phone_lookups pl ON pl.phone = li.phone_e164
      WHERE li.status IN ('received', 'awaiting_lookup')
        AND (li.status = 'received' OR pl.lookup_status = 'complete')
      ORDER BY li.received_at
      LIMIT ${BATCH_SIZE}
      FOR UPDATE OF li SKIP LOCKED
    `)) as unknown as InboxRow[];

    res.claimed = rows.length;
    if (rows.length === 0) return;

    const orgId = rows[0].org_id;
    toEnqueue.orgId = orgId;
    const day = etDay(now);

    // Group ids resolved once per batch, not per lead.
    const realGroup = await ensureDripGroup(tx, { orgId, sandbox: false });
    const sandboxGroup = await ensureDripGroup(tx, { orgId, sandbox: true });

    // Budget for THIS batch's cache misses (ET-day drip sub-cap).
    const misses = rows.filter(
      (r) => r.status === "received" && !r.sandbox && r.phone_e164 && !r.lookup_complete,
    );
    const budget = await dripLookupBudget(tx, { orgId, want: misses.length, now });
    res.capReached = budget.allowed < misses.length;
    let allowance = budget.allowed;

    for (const row of rows) {
      const mapping = (row.field_mapping ?? {}) as Record<string, string>;
      const normalized = normalizeLead(row.raw ?? {}, mapping);

      // A row with no phone should never have reached 'received' (intake stores
      // it as 'rejected'), but a defensive terminal beats an infinite reclaim.
      if (!row.phone_e164) {
        await tx.execute(sql`
          UPDATE lead_inbox SET status='rejected', error=COALESCE(error,'no phone at enrichment'),
                 processed_at=now(), normalized=${JSON.stringify(normalized)}::jsonb
          WHERE id = ${row.id}`);
        await bumpIntakeCounters(tx, {
          orgId, partnerKeyId: row.partner_key_id, day,
          interestTag: row.interest_tag,
          deltas: row.sandbox ? { sandbox: 1 } : { received: 1, rejected: 1 },
        });
        res.rejected++;
        continue;
      }

      // ── SANDBOX: full pipeline EXCEPT Telnyx and EXCEPT the real group ──
      // Skipping the lookup is what makes sandbox free; the separate group is
      // what makes it unsendable. Counted ONLY as `sandbox`, so Phase 7 reads
      // real partner volume without filtering.
      const needsLookup = !row.sandbox && !row.lookup_complete;

      if (needsLookup) {
        if (allowance <= 0) {
          // ⚠️ CAP REACHED: LEAVE THE ROW AS 'received'. Do NOT park it in
          // 'awaiting_lookup' — that status means "enqueued, waiting on Telnyx",
          // and the claim only re-picks such a row once its lookup is COMPLETE.
          // A row parked there without ever being enqueued would therefore never
          // be claimed again: stranded silently, forever. Leaving it 'received'
          // keeps it claimable on the next tick, which is the whole invariant.
          // The normalized payload is still saved, so the work is not redone.
          await tx.execute(sql`
            UPDATE lead_inbox SET normalized=${JSON.stringify(normalized)}::jsonb
            WHERE id = ${row.id}`);
          res.capDeferred++;
          continue;
        }
        allowance--;
        const bkey = `${row.partner_key_id} ${(row.interest_tag ?? "").trim()}`;
        const bucket =
          toEnqueue.byKey.get(bkey) ??
          { partnerKeyId: row.partner_key_id, tag: (row.interest_tag ?? "").trim(), phones: [] };
        bucket.phones.push(row.phone_e164);
        toEnqueue.byKey.set(bkey, bucket);
        await tx.execute(sql`
          UPDATE lead_inbox SET status='awaiting_lookup',
                 normalized=${JSON.stringify(normalized)}::jsonb
          WHERE id = ${row.id}`);
        res.awaitingLookup++;
        res.lookupsEnqueued++;
        continue;
      }

      // ── the lookup verdict ──────────────────────────────────────────────
      // Sandbox leads are marked lookup-skipped and treated as unknown.
      const lineType = row.sandbox ? null : row.line_type;

      // ⚠️ ONLY 'landline' IS DISCARDED (ruling G19). voip and unknown are
      // saved and processed exactly like mobile, matching the existing policy
      // in lib/telnyx/map-line-type.ts — "we never silently suppress a number
      // we're unsure about" — and stamped so Phase 4 can filter per campaign.
      if (lineType === "landline") {
        await bumpIntakeCounters(tx, {
          orgId, partnerKeyId: row.partner_key_id, day,
          interestTag: row.interest_tag,
          deltas: { received: 1, landline: 1 },
        });
        // Counted, THEN removed — same transaction, so there is no window in
        // which the lead is neither a row nor a count.
        await tx.execute(sql`DELETE FROM lead_inbox WHERE id = ${row.id}`);
        res.landline++;
        continue;
      }

      // ── mobile / voip / unknown: create or update the contact ───────────
      const contact = (await tx.execute(sql`
        INSERT INTO contacts (org_id, phone_number)
        VALUES (${orgId}::uuid, ${row.phone_e164})
        ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now()
        RETURNING id`)) as unknown as { id: string }[];
      const contactId = contact[0].id;

      // Attributes: only mapped, non-null fields, and NEVER blank a known
      // value — the COALESCE direction is the whole point.
      const n = normalized as Record<string, string | boolean | null>;
      await tx.execute(sql`
        INSERT INTO contact_attributes AS ca
          (contact_id, org_id, first_name, last_name, address, state, country, email,
           gender, income_band, kids, married, dob, interest_tag, partner_slug, source)
        VALUES (${contactId}::uuid, ${orgId}::uuid,
                ${n.first_name ?? null}, ${n.last_name ?? null}, ${n.address ?? null},
                ${n.state ?? null}, ${n.country ?? null}, ${n.email ?? null},
                ${n.gender ?? null}, ${n.income_band ?? null},
                ${n.kids ?? null}, ${n.married ?? null}, ${(n.dob as string) ?? null},
                ${row.interest_tag}, ${row.partner_slug}, 'drip_intake')
        ON CONFLICT (contact_id) DO UPDATE SET
          first_name   = COALESCE(EXCLUDED.first_name,   ca.first_name),
          last_name    = COALESCE(EXCLUDED.last_name,    ca.last_name),
          address      = COALESCE(EXCLUDED.address,      ca.address),
          state        = COALESCE(EXCLUDED.state,        ca.state),
          country      = COALESCE(EXCLUDED.country,      ca.country),
          email        = COALESCE(EXCLUDED.email,        ca.email),
          gender       = COALESCE(EXCLUDED.gender,       ca.gender),
          income_band  = COALESCE(EXCLUDED.income_band,  ca.income_band),
          kids         = COALESCE(EXCLUDED.kids,         ca.kids),
          married      = COALESCE(EXCLUDED.married,      ca.married),
          dob          = COALESCE(EXCLUDED.dob,          ca.dob),
          interest_tag = COALESCE(EXCLUDED.interest_tag, ca.interest_tag),
          partner_slug = COALESCE(EXCLUDED.partner_slug, ca.partner_slug),
          source       = COALESCE(EXCLUDED.source,       ca.source)`);

      // The arrival ledger. ON CONFLICT DO NOTHING against the partial unique
      // on inbox_id makes a crashed-and-retried batch a no-op rather than a
      // second event for the same arrival.
      await tx.execute(sql`
        INSERT INTO lead_events
          (org_id, contact_id, partner_key_id, partner_slug, interest_tag,
           received_at, inbox_id, sandbox, line_type)
        VALUES (${orgId}::uuid, ${contactId}::uuid, ${row.partner_key_id}, ${row.partner_slug},
                ${row.interest_tag}, ${row.received_at}::timestamptz, ${row.id}::uuid,
                ${row.sandbox}, ${lineType})
        ON CONFLICT (inbox_id) WHERE inbox_id IS NOT NULL DO NOTHING`);

      await addContactsToGroup(tx, {
        orgId,
        groupId: row.sandbox ? sandboxGroup : realGroup,
        contactIds: [contactId],
      });

      await tx.execute(sql`
        UPDATE lead_inbox SET status='processed', processed_at=now(),
               normalized=${JSON.stringify(normalized)}::jsonb
        WHERE id = ${row.id}`);

      await bumpIntakeCounters(tx, {
        orgId, partnerKeyId: row.partner_key_id, day,
        interestTag: row.interest_tag,
        deltas: row.sandbox
          ? { sandbox: 1 }
          : { received: 1, [counterForLineType(lineType)]: 1 },
      });
      res.processed++;
    }
  });

  // Enqueue AFTER the claim transaction commits. Priority 100 so drip jumps
  // ahead of bulk uploads in the account-global queue (migration 0158); every
  // existing caller stays at the default 0, so their relative order is
  // unchanged.
  const allPhones = [...toEnqueue.byKey.values()].flatMap((b) => b.phones);
  if (allPhones.length > 0) {
    await enqueueNormalized(toEnqueue.orgId, allPhones, "drip_intake");

    // Priority 100 so drip jumps the account-global FIFO queue. Scoped to
    // priority = 0 so it can never demote a row another caller already raised.
    await db.execute(sql`
      UPDATE lookup_queue SET priority = 100
      WHERE status = 'pending' AND priority = 0
        AND phone = ANY(${sql`ARRAY[${sql.join(allPhones.map((p) => sql`${p}`), sql`, `)}]::text[]`})`);

    // Telnyx calls actually made, attributed to the partner that caused them.
    // Cache hits never reach here, which is why this counts calls and not leads.
    const day = etDay(now);
    for (const b of toEnqueue.byKey.values()) {
      await bumpIntakeCounters(db, {
        orgId: toEnqueue.orgId,
        partnerKeyId: b.partnerKeyId,
        day,
        interestTag: b.tag,
        deltas: { lookups_spent: b.phones.length },
      });
    }
  }

  return res;
}
