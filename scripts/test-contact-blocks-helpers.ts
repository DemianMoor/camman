// PR 2 bar for contact blocks + soft delete (0237).
// Spec: docs/superpowers/specs/2026-11-06-contact-blocks-soft-delete-design.md §10.
//
//   V2  the D2 interaction table, all 9 rows incl. A1 (unblock an archived
//       contact ⇒ a 'deleted' row replaces the block), with BOTH invariants
//       re-checked after every transition; findActiveBlocks flags a contact
//       that is archived / blocked with no ledger row; a ledger-only phone (no
//       contact) blocks and creates no contact; a batch releases.
//   V3  unblock never touches opt_outs.
//   V6  cancel at block time: pending → filtered/contact_blocked, `sending`
//       untouched, pool rows gone, live drip journey → exited/contact_blocked;
//       soft delete cancels with contact_deleted; a 12,000-phone block runs in
//       3 chunks and the counts add up.
//   V8  imports: processAudienceUpload skips blocked + deleted + ledger-only
//       phones (no contact, no entity row, no group), and with blockCheck:false
//       (the opt-out upload) lets every phone through. Plus a source bar per
//       route: the block check runs before the route's first contact write.
//   V9  drip intake: a lead for a blocked phone is discarded — no contact, no
//       lead_event, inbox row gone, lead_intake_daily.blocked +1, no lookup.
//   R   readers: lookup-stats reconciles with blocked/deleted contacts present
//       (it threw before PR 2), and the contact-stats rollup counts `blocked`.
//
// Own marker org on the PREVIEW DB, torn down by id. The drain re-check (V7) is
// scripts/test-send-optout-invariant.ts.
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-contact-blocks-helpers.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { createPartnerWithKey } from "./_partner-fixture";
import { fictionalPhones, refuseIfPhonesInUse } from "./_fictional-phones";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { sql, type SQL } from "drizzle-orm";

import { db, sql as pgConn } from "@/db/client";

// libphonenumber-js mis-loads its metadata under tsx (works in Next.js) — the
// test-lookup-uploads.ts stub. Strict validatePhone itself is covered by
// scripts/test-phone-normalizer-agreement.ts; here the fixture numbers are E.164.
const req = createRequire(import.meta.url);
try {
  const lp = req.resolve("libphonenumber-js");
  const stubParse = (input: string) => {
    const m = /^\+1(\d{10})$/.exec(String(input).trim());
    if (!m) return null;
    return { number: `+1${m[1]}`, country: "US", countryCallingCode: "1", nationalNumber: m[1], isValid: () => true, isPossible: () => true };
  };
  // @ts-expect-error minimal module stub
  req.cache[lp] = { id: lp, filename: lp, loaded: true, exports: { parsePhoneNumberFromString: stubParse } };
} catch { /* noop */ }

const MARKER = "__CONTACT_BLOCKS_HELPERS_TEST__";
let fail = 0;
const bar = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const B = await import("@/lib/contacts/blocks");
  const { processAudienceUpload } = await import("@/lib/upload/audience-upload");
  const { runEnrichmentBatch } = await import("@/lib/drip/enrichment");
  const { computeLookupGroupStats } = await import("@/lib/telnyx/lookup-stats");
  const { refreshContactOrgStats } = await import("@/lib/contact-stats");

  const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> => (await db.execute(q)) as unknown as T[];
  const tx = <T>(f: (t: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) => db.transaction(f);

  const pending = (await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM lead_inbox WHERE status IN ('received','awaiting_lookup')`)).n;
  if (pending > 0) throw new Error(`REFUSING: lead_inbox already has ${pending} claimable row(s)`);

  // Outside NPA 200..319, which the 12,000-phone bulk fixture below uses.
  const P = fictionalPhones(120).filter((p) => Number(p.slice(2, 5)) >= 320).slice(0, 20);
  if (P.length < 20) throw new Error("could not draw 20 fixture phones");
  await refuseIfPhonesInUse(db, P);
  const sfx = String(Date.now()).slice(-7);
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${sfx}`}) RETURNING id`)).id;
    const contact = async (phone: string, lineType = "mobile") =>
      (await one<{ id: string }>(sql`
        INSERT INTO contacts (org_id, phone_number, line_type) VALUES (${orgId}::uuid, ${phone}, ${lineType}) RETURNING id`)).id;
    const state = (id: string) => one<{ ms: string; blocked_at: string | null; block_reason: string | null; archived: boolean; is_archived: boolean }>(sql`
      SELECT messaging_status AS ms, blocked_at, block_reason, archived_at IS NOT NULL AS archived, is_archived
      FROM contacts WHERE id = ${id}::uuid`);
    const active = (phone: string) => all<{ id: number; reason: string }>(sql`
      SELECT id, reason FROM contact_blocks WHERE org_id = ${orgId}::uuid AND phone_number = ${phone} AND released_at IS NULL`);
    const invariants = async (label: string) => {
      const v = await one<{ i1: number; a1: number }>(sql`
        SELECT
          (SELECT count(*) FROM contacts c WHERE c.org_id = ${orgId}::uuid
             AND (c.blocked_at IS NOT NULL) <> EXISTS (
               SELECT 1 FROM contact_blocks b WHERE b.org_id = c.org_id AND b.phone_number = c.phone_number
                 AND b.released_at IS NULL AND b.reason <> 'deleted'))::int AS i1,
          (SELECT count(*) FROM contacts c WHERE c.org_id = ${orgId}::uuid AND c.archived_at IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM contact_blocks b WHERE b.org_id = c.org_id AND b.phone_number = c.phone_number
                 AND b.released_at IS NULL))::int AS a1`);
      bar(`   invariants hold after ${label}`, v.i1 === 0 && v.a1 === 0, `blocked_at⇔ledger violations ${v.i1}, archived-without-row ${v.a1}`);
    };
    const block = (phones: string[], reason: "manual" | "provider_list" = "manual", batchId: number | null = null) =>
      tx((t) => B.blockPhones(t, { orgId, phones, reason, source: "test", note: null, actorId: null, batchId }));

    // ── V2 ──────────────────────────────────────────────────────────────────
    console.log("V2 — D2 interaction table");
    const c1 = await contact(P[0]);
    let r = await block([P[0]]);
    let s = await state(c1);
    bar("D1 block, no active row ⇒ row inserted, contact blocked",
      r.blocked_added === 1 && s.ms === "blocked" && s.block_reason === "manual" && (await active(P[0]))[0]?.reason === "manual",
      JSON.stringify({ r, s }));
    await invariants("D1");

    r = await block([P[0]], "provider_list");
    bar("D3 block, another block reason active ⇒ no-op, already_blocked",
      r.blocked_added === 0 && r.already_blocked === 1 && (await active(P[0])).length === 1 && (await state(c1)).block_reason === "manual");
    await invariants("D3");

    const c2 = await contact(P[1]);
    const d = await tx((t) => B.softDeleteContacts(t, { orgId, contactIds: [c2], actorId: null }));
    s = await state(c2);
    bar("D4 delete, no active row ⇒ 'deleted' row, archived (is_archived kept in step), status blocked",
      d.contacts_deleted === 1 && d.deleted_rows_inserted === 1 && s.archived && s.is_archived && s.ms === "blocked" &&
      s.blocked_at === null && (await active(P[1]))[0]?.reason === "deleted", JSON.stringify(s));
    await invariants("D4");

    r = await block([P[1]]);
    s = await state(c2);
    const hist2 = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM contact_blocks WHERE org_id = ${orgId}::uuid AND phone_number = ${P[1]}`);
    bar("D2 block, 'deleted' active ⇒ deleted released + block inserted (history kept), still archived",
      r.blocked_added === 1 && (await active(P[1]))[0]?.reason === "manual" && hist2.n === 2 && s.archived && s.block_reason === "manual",
      JSON.stringify({ r, s, rows: hist2.n }));
    await invariants("D2");

    await tx((t) => B.softDeleteContacts(t, { orgId, contactIds: [c1], actorId: null }));
    s = await state(c1);
    bar("D5 delete, a block reason active ⇒ block row kept, archived set",
      s.archived && s.block_reason === "manual" && (await active(P[0])).map((x) => x.reason).join() === "manual");
    await invariants("D5");

    const c3 = await contact(P[2]);
    await db.execute(sql`INSERT INTO opt_outs (org_id, contact_id, phone_number, reason, source) VALUES (${orgId}::uuid, ${c3}::uuid, ${P[2]}, 'opt_out', 'test')`);
    await block([P[2]]);
    const u = await tx((t) => B.unblockPhones(t, { orgId, phones: [P[2]], actorId: null }));
    s = await state(c3);
    const oo = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM opt_outs WHERE contact_id = ${c3}::uuid`);
    bar("D6 unblock, not archived ⇒ released, blocked_at cleared", u.released === 1 && s.blocked_at === null && s.ms === "eligible" && (await active(P[2])).length === 0, JSON.stringify(u));
    bar("V3 unblock never touches opt_outs (the contact stays suppressed)", oo.n === 1);
    await invariants("D6");

    const u2 = await tx((t) => B.unblockPhones(t, { orgId, phones: [P[0]], actorId: null }));
    s = await state(c1);
    bar("D7 unblock, archived (A1) ⇒ block released AND 'deleted' row inserted; still archived",
      u2.released === 1 && u2.deleted_rows_inserted === 1 && s.blocked_at === null && s.archived && s.ms === "blocked" &&
      (await active(P[0]))[0]?.reason === "deleted", JSON.stringify({ u2, s }));
    await invariants("D7 (A1)");

    const rs = await tx((t) => B.restoreContacts(t, { orgId, contactIds: [c1], actorId: null }));
    s = await state(c1);
    bar("D8 restore, 'deleted' active ⇒ released, archived cleared, eligible",
      rs.contacts_restored === 1 && rs.deleted_rows_released === 1 && !s.archived && !s.is_archived && s.ms === "eligible" && (await active(P[0])).length === 0);
    await invariants("D8");

    await tx((t) => B.restoreContacts(t, { orgId, contactIds: [c2], actorId: null }));
    s = await state(c2);
    bar("D9 restore, a block reason active ⇒ archived cleared, still blocked",
      !s.archived && s.ms === "blocked" && (await active(P[1]))[0]?.reason === "manual");
    await invariants("D9");

    const cH = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM contacts WHERE org_id = ${orgId}::uuid AND phone_number = ${P[3]}`);
    r = await block([P[3]]);
    const cH2 = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM contacts WHERE org_id = ${orgId}::uuid AND phone_number = ${P[3]}`);
    bar("H ledger-only phone: blocked, no contact created", cH.n === 0 && r.blocked_added === 1 && r.contacts_updated === 0 && cH2.n === 0);

    const cStray = await contact(P[4]);
    await db.execute(sql`UPDATE contacts SET archived_at = now() WHERE id = ${cStray}::uuid`); // simulated invariant break
    const cStray2 = await contact(P[5]);
    await db.execute(sql`UPDATE contacts SET blocked_at = now(), block_reason = 'complaint' WHERE id = ${cStray2}::uuid`);
    const origErr = console.error;
    const logged: unknown[][] = [];
    console.error = (...a: unknown[]) => { logged.push(a); };
    const found = await B.findActiveBlocks(db, orgId, [P[0], P[1], P[3], P[4], P[5]]);
    console.error = origErr;
    bar("A1 belt-and-braces: archived / blocked contact with no ledger row is treated as blocked",
      found.get(P[4]) === "deleted" && found.get(P[5]) === "complaint" && found.get(P[1]) === "manual" && found.get(P[3]) === "manual" && !found.has(P[0]),
      JSON.stringify([...found]));
    bar("A1 the mismatch is logged as an invariant violation, without the phone",
      logged.length === 2 && logged.every((a) => String(a[0]).includes("[contact-blocks] invariant") && !JSON.stringify(a).includes(P[4]) && !JSON.stringify(a).includes(P[5])));
    // repair the simulated break so the rest of the run starts clean
    await db.execute(sql`UPDATE contacts SET archived_at = NULL WHERE id = ${cStray}::uuid`);
    await db.execute(sql`UPDATE contacts SET blocked_at = NULL, block_reason = NULL WHERE id = ${cStray2}::uuid`);

    const batch = (await one<{ id: number }>(sql`
      INSERT INTO contact_block_batches (org_id, reason, submitted_rows, valid_rows, invalid_rows)
      VALUES (${orgId}::uuid, 'manual', 3, 3, 0) RETURNING id`)).id;
    const cb = await contact(P[6]);
    await block([P[6], P[7], P[8]], "manual", batch);
    const rel = await tx((t) => B.releaseBatch(t, { orgId, batchId: batch, actorId: null }));
    const bRow = await one<{ released_count: number; released: boolean }>(sql`
      SELECT released_count, released_at IS NOT NULL AS released FROM contact_block_batches WHERE id = ${batch}`);
    bar("V10-lite releaseBatch: every row released, contact unblocked, batch stamped",
      rel?.released === 3 && bRow.released_count === 3 && bRow.released && (await state(cb)).ms === "eligible", JSON.stringify({ rel, bRow }));
    await invariants("releaseBatch");

    // ── V6 ──────────────────────────────────────────────────────────────────
    console.log("\nV6 — cancel at block time");
    const camp = (await one<{ id: number }>(sql`
      INSERT INTO campaigns (org_id, slug, name, status, type, link_mode)
      VALUES (${orgId}::uuid, ${`cb-${sfx}`}, 'CB', 'active', 'drip', 'tracked') RETURNING id`)).id;
    const stage = (await one<{ id: number }>(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number) VALUES (${orgId}::uuid, ${camp}, 1) RETURNING id`)).id;
    const stage2 = (await one<{ id: number }>(sql`
      INSERT INTO campaign_stages (org_id, campaign_id, stage_number) VALUES (${orgId}::uuid, ${camp}, 2) RETURNING id`)).id;
    const { keyId } = await createPartnerWithKey(db, { orgId, slug: `cb-${sfx}`, token: `tokcb${sfx}`, sandbox: false });
    const cG = await contact(P[9]);
    const send = (cid: string, phone: string, status: string, st = stage) => db.execute(sql`
      INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
      VALUES (${orgId}::uuid, ${camp}, ${st}, ${cid}::uuid, ${phone}, 'x', ${status})`);
    await send(cG, P[9], "pending");
    await send(cG, P[9], "sending", stage2); // one live row per (stage, contact)
    await db.execute(sql`INSERT INTO campaign_audience_pool (campaign_id, contact_id, org_id) VALUES (${camp}, ${cG}::uuid, ${orgId}::uuid)`);
    const le = (await one<{ id: string }>(sql`
      INSERT INTO lead_events (org_id, contact_id, partner_key_id, partner_slug, received_at)
      VALUES (${orgId}::uuid, ${cG}::uuid, ${keyId}, ${`cb-${sfx}`}, now()) RETURNING id`)).id;
    await db.execute(sql`
      INSERT INTO drip_journeys (org_id, campaign_id, contact_id, lead_event_id, state)
      VALUES (${orgId}::uuid, ${camp}, ${cG}::uuid, ${le}::uuid, 'active')`);
    r = await block([P[9]]);
    const sends = await all<{ status: string; last_error: string | null }>(sql`
      SELECT status, last_error FROM stage_sends WHERE contact_id = ${cG}::uuid ORDER BY status`);
    const pool = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM campaign_audience_pool WHERE contact_id = ${cG}::uuid`);
    const j = await one<{ state: string; close_reason: string; closed: boolean }>(sql`
      SELECT state, close_reason, closed_at IS NOT NULL AS closed FROM drip_journeys WHERE contact_id = ${cG}::uuid`);
    bar("pending → filtered / contact_blocked; sending untouched",
      JSON.stringify(sends) === JSON.stringify([{ status: "filtered", last_error: "contact_blocked" }, { status: "sending", last_error: null }]),
      JSON.stringify(sends));
    bar("pool row removed; live journey → exited / contact_blocked (D4)",
      pool.n === 0 && j.state === "exited" && j.close_reason === "contact_blocked" && j.closed && r.sends_cancelled === 1 && r.pool_removed === 1 && r.journeys_closed === 1,
      JSON.stringify({ pool: pool.n, j, r }));

    const cG2 = await contact(P[10]);
    await send(cG2, P[10], "pending");
    const d2 = await tx((t) => B.softDeleteContacts(t, { orgId, contactIds: [cG2], actorId: null }));
    const s2 = await one<{ status: string; last_error: string }>(sql`SELECT status, last_error FROM stage_sends WHERE contact_id = ${cG2}::uuid`);
    bar("soft delete cancels with contact_deleted", d2.sends_cancelled === 1 && s2.status === "filtered" && s2.last_error === "contact_deleted", JSON.stringify(s2));

    // 12,000 phones: +1 NPA 555 01XX for NPA 200..319 — fictional, and the org is new.
    await db.execute(sql`
      INSERT INTO contacts (org_id, phone_number)
      SELECT ${orgId}::uuid, '+1' || npa || '55501' || lpad(xx::text, 2, '0')
      FROM generate_series(200, 319) npa, generate_series(0, 99) xx
      ON CONFLICT (org_id, phone_number) DO NOTHING`);
    await db.execute(sql`
      INSERT INTO stage_sends (org_id, campaign_id, stage_id, contact_id, phone, rendered_text, status)
      SELECT ${orgId}::uuid, ${camp}, ${stage}, c.id, c.phone_number, 'x', 'pending'
      FROM contacts c WHERE c.org_id = ${orgId}::uuid AND c.phone_number ~ '^\\+1(2[0-9][0-9]|3[01][0-9])55501[0-9]{2}$'
        AND c.blocked_at IS NULL AND c.archived_at IS NULL`);
    const bulk = (await all<{ phone_number: string }>(sql`
      SELECT phone_number FROM contacts WHERE org_id = ${orgId}::uuid AND phone_number ~ '^\\+1(2[0-9][0-9]|3[01][0-9])55501[0-9]{2}$'`)).map((x) => x.phone_number);
    const preBlocked = await one<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM contacts WHERE org_id = ${orgId}::uuid AND phone_number = ANY(${`{${bulk.join(",")}}`}::text[])
        AND (blocked_at IS NOT NULL OR archived_at IS NOT NULL)`);
    const t0 = Date.now();
    const rb = await block(bulk);
    const ms = Date.now() - t0;
    const fresh = bulk.length - preBlocked.n;
    bar(`12,000-phone block in 3 chunks: counts add up (${(ms / 1000).toFixed(1)}s)`,
      bulk.length === 12000 && rb.blocked_added + rb.already_blocked === 12000 && rb.contacts_updated === rb.blocked_added &&
      rb.sends_cancelled === fresh,
      JSON.stringify({ phones: bulk.length, preBlocked: preBlocked.n, ...rb }));
    await invariants("12,000-phone block");

    // ── V8 ──────────────────────────────────────────────────────────────────
    console.log("\nV8 — imports");
    // P[0] active (restored), P[1] blocked, P[11] deleted, P[3] ledger-only, P[12] new
    const cDel = await contact(P[11]);
    await tx((t) => B.softDeleteContacts(t, { orgId, contactIds: [cDel], actorId: null }));
    const group = (await one<{ id: number }>(sql`
      INSERT INTO contact_groups (org_id, contact_group_id, name) VALUES (${orgId}::uuid, ${`cbg-${sfx}`}, 'cbg') RETURNING id`)).id;
    const entityRows: string[] = [];
    const up = await processAudienceUpload({
      orgId,
      rawPhones: [P[0], P[1], P[11], P[3], P[12]].join("\n"),
      assignToGroupIds: [group],
      blockCheck: true,
      insertEntities: async (rows) => { entityRows.push(...rows.map((x) => x.phone_number)); return rows.length; },
    });
    const members = await all<{ phone_number: string }>(sql`
      SELECT c.phone_number FROM contact_contact_groups g JOIN contacts c ON c.id = g.contact_id WHERE g.contact_group_id = ${group}`);
    const hAfter = await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM contacts WHERE org_id = ${orgId}::uuid AND phone_number = ${P[3]}`);
    bar("blocked = 3 (deleted 1, blocked 2); samples listed",
      up.blocked === 3 && up.blocked_by_reason.deleted === 1 && up.blocked_by_reason.blocked === 2 && up.blocked_samples.length === 3,
      JSON.stringify({ blocked: up.blocked, by: up.blocked_by_reason }));
    bar("only the active + new phones reach the entity insert and the group; no contact for the ledger-only phone",
      entityRows.sort().join() === [P[0], P[12]].sort().join() && members.map((m) => m.phone_number).sort().join() === [P[0], P[12]].sort().join() && hAfter.n === 0,
      JSON.stringify({ entityRows, members: members.length, h: hAfter.n }));
    const passRows: string[] = [];
    const up2 = await processAudienceUpload({
      orgId,
      rawPhones: [P[1], P[11]].join("\n"),
      blockCheck: false,
      insertEntities: async (rows) => { passRows.push(...rows.map((x) => x.phone_number)); return rows.length; },
    });
    bar("blockCheck:false (opt-out upload) lets blocked and deleted phones through", up2.blocked === 0 && passRows.length === 2);

    const firstWrite = (file: string, check: RegExp, write: RegExp) => {
      const text = readFileSync(file, "latin1");
      const c = text.search(check);
      const w = text.search(write);
      return c >= 0 && w >= 0 && c < w;
    };
    const routes: [string, RegExp, RegExp][] = [
      ["app/api/contacts/upload/route.ts", /partitionBlocked\(/, /\.insert\(contacts\)/],
      ["lib/upload/audience-upload.ts", /partitionBlocked\(/, /\.insert\(contacts\)/],
      ["app/api/contact-groups/[id]/contacts/add/route.ts", /partitionBlocked\(/, /\.insert\(contacts\)/],
      ["app/api/campaigns/[campaignId]/upload-contacts/route.ts", /partitionBlocked\(/, /\.insert\(contacts\)/],
      ["app/api/campaigns/[campaignId]/stages/[stageId]/import/route.ts", /partitionBlocked\(/, /\.insert\(contacts\)/],
      ["app/api/contacts/statuses/import/route.ts", /findActiveBlocks\(/, /\.insert\(contacts\)/],
      ["lib/drip/enrichment.ts", /findActiveBlocks\(/, /INSERT INTO contacts/],
    ];
    for (const [file, c, w] of routes) bar(`source: block check precedes the first contact write — ${file}`, firstWrite(file, c, w));
    const callers: [string, string][] = [
      ["app/api/opt-ins/upload/route.ts", "blockCheck: true"],
      ["app/api/clickers/upload/route.ts", "blockCheck: true"],
      ["app/api/segments/[id]/contacts/upload/route.ts", "blockCheck: true"],
      ["app/api/opt-outs/upload/route.ts", "blockCheck: false"],
    ];
    for (const [file, want] of callers) bar(`source: ${file} passes ${want}`, readFileSync(file, "utf8").includes(want));
    bar("source: the opt-out attribution importer (path 7) is exempt — no block check",
      !/contacts\/blocks/.test(readFileSync("lib/sends/import-optout-attribution.ts", "utf8")));

    // ── V9 ──────────────────────────────────────────────────────────────────
    console.log("\nV9 — drip intake");
    await db.execute(sql`
      INSERT INTO phone_lookups (phone, line_type, source, lookup_status, looked_up_at)
      VALUES (${P[13]}, 'mobile', 'manual_edit', 'complete', now())`);
    await block([P[13]]); // ledger-only block for a phone the org has never seen
    await db.execute(sql`
      INSERT INTO lead_inbox (org_id, partner_key_id, partner_slug, received_at, raw, phone_e164, interest_tag)
      VALUES (${orgId}::uuid, ${keyId}, ${`cb-${sfx}`}, now() - interval '1 minute', ${JSON.stringify({ phone: P[13] })}::jsonb, ${P[13]}, 'cb')`);
    const enr = await runEnrichmentBatch();
    const leadLeft = await one<{ inbox: number; contacts: number; events: number; blocked: number; received: number }>(sql`
      SELECT (SELECT count(*) FROM lead_inbox WHERE org_id = ${orgId}::uuid)::int AS inbox,
             (SELECT count(*) FROM contacts WHERE org_id = ${orgId}::uuid AND phone_number = ${P[13]})::int AS contacts,
             (SELECT count(*) FROM lead_events le JOIN contacts c ON c.id = le.contact_id WHERE c.phone_number = ${P[13]})::int AS events,
             COALESCE((SELECT sum(blocked) FROM lead_intake_daily WHERE org_id = ${orgId}::uuid), 0)::int AS blocked,
             COALESCE((SELECT sum(received) FROM lead_intake_daily WHERE org_id = ${orgId}::uuid), 0)::int AS received`);
    bar("blocked lead discarded: inbox row gone, no contact, no lead_event; daily blocked +1 inside received",
      enr.blocked === 1 && enr.processed === 0 && enr.lookupsEnqueued === 0 &&
      leadLeft.inbox === 0 && leadLeft.contacts === 0 && leadLeft.events === 0 && leadLeft.blocked === 1 && leadLeft.received === 1,
      JSON.stringify({ enrBlocked: enr.blocked, processed: enr.processed, ...leadLeft }));

    // ── R ───────────────────────────────────────────────────────────────────
    console.log("\nR — readers");
    // group holds: P[0] eligible, P[1] blocked, P[12] eligible (from V8), + a deleted, a landline-blocked, an opted-out-blocked
    const cDelG = await contact(P[14]);
    await tx((t) => B.softDeleteContacts(t, { orgId, contactIds: [cDelG], actorId: null }));
    const cLand = await contact(P[15], "landline");
    await block([P[15]]);
    const cOoB = await contact(P[16]);
    await db.execute(sql`INSERT INTO opt_outs (org_id, contact_id, phone_number, reason, source) VALUES (${orgId}::uuid, ${cOoB}::uuid, ${P[16]}, 'opt_out', 'test')`);
    await block([P[16]]);
    await db.execute(sql`
      INSERT INTO contact_contact_groups (contact_id, contact_group_id, org_id)
      SELECT id, ${group}, ${orgId}::uuid FROM contacts WHERE id IN (${cDelG}::uuid, ${cLand}::uuid, ${cOoB}::uuid, ${c2}::uuid)
      ON CONFLICT DO NOTHING`);
    let ls: Awaited<ReturnType<typeof computeLookupGroupStats>> | null = null;
    let lsErr = "";
    try { ls = await computeLookupGroupStats(orgId); } catch (e) { lsErr = (e as Error).message; }
    const g = ls?.groups.find((x) => x.group_id === group);
    bar("lookup-stats reconciles with blocked + deleted members (threw before PR 2)",
      !!g && g.total === 6 && g.sendable === 2 && g.landlines === 1 && g.opt_outs === 1 && g.blocked === 2,
      lsErr || JSON.stringify(g));
    await refreshContactOrgStats(db, orgId);
    const cs = await one<{ ms: { eligible: number; not_applicable: number; blocked: number } }>(sql`
      SELECT carrier_breakdown->'by_messaging_status' AS ms FROM contact_org_stats WHERE org_id = ${orgId}::uuid`);
    const truth = await one<{ e: number; na: number; b: number }>(sql`
      SELECT count(*) FILTER (WHERE messaging_status = 'eligible')::int AS e,
             count(*) FILTER (WHERE messaging_status = 'not_applicable')::int AS na,
             count(*) FILTER (WHERE messaging_status = 'blocked')::int AS b
      FROM contacts WHERE org_id = ${orgId}::uuid`);
    bar("contact-stats rollup: eligible / not_applicable / blocked match the table",
      cs.ms.eligible === truth.e && cs.ms.not_applicable === truth.na && cs.ms.blocked === truth.b && truth.b > 0,
      JSON.stringify({ rollup: cs.ms, truth }));
  } finally {
    if (orgId) {
      const name = (await one<{ name: string } | undefined>(sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
        fail++;
      } else {
        for (const t of ["drip_journeys", "lead_events", "lead_inbox", "lead_intake_daily", "lead_intake_hourly", "stage_sends",
          "campaign_audience_pool", "contact_blocks", "contact_block_batches", "opt_outs", "contact_org_stats"]) {
          await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE org_id = ${orgId}::uuid`);
        }
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
    }
    await db.execute(sql`DELETE FROM phone_lookups WHERE phone = ${P[13]} AND source = 'manual_edit'`);
    await db.execute(sql`DELETE FROM lookup_queue WHERE phone = ${P[13]}`);
    const left = await one<{ n: number }>(sql`
      SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM contacts WHERE org_id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM contact_blocks WHERE org_id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM phone_lookups WHERE phone = ${P[13]}))::int AS n`);
    console.log(`\nTeardown: ${left.n} row(s) left`);
    if (left.n !== 0) fail++;
    await pgConn.end({ timeout: 5 });
  }
  console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
