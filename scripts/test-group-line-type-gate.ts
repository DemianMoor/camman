import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second — refuses any target but the preview DB
import { createPartnerWithKey } from "./_partner-fixture";
import { fictionalPhones, refuseIfPhonesInUse } from "./_fictional-phones";
import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import { previewAudience } from "@/lib/audience-snapshot";
import { runEnrichmentBatch } from "@/lib/drip/enrichment";
import { classifyRoutingOutcome, evaluateLeadRouting } from "@/lib/drip/routing-eval";
import { buildSegmentAudienceClause } from "@/lib/segment-rules-eval";

// Contact-group line-type gate (migration 0218), PREVIEW DB.
//
//   DATABASE_URL="$(grep '^DATABASE_URL=' D:/AFF/camman/.env.demo | cut -d= -f2-)" \
//     npx tsx --conditions=react-server scripts/test-group-line-type-gate.ts
//
//   I1 drip intake copies phone_lookups.line_type onto the new contact (was left 'unknown')
//   G1 group side: a strict group's voip + unknown leave a campaign that selects
//      a DIFFERENT (permissive) group — strictest group wins, everywhere
//   G2 segment side (manual membership) — same set
//   G3 only allow_voip=false: voip out, unknown back in
//   G4 an ARCHIVED strict group blocks nothing
//   G5 both boxes checked ⇒ byte-for-byte today's audience
//   D1 drip routing: a blocked lead fails global `line_type` and is PERMANENT
//   D2 drip routing: mobile and an un-grouped voip lead pass `line_type`
//
// Own throwaway org; every row is torn down by id and the residue is counted.

const MARKER = "__GROUP_LINE_TYPE_GATE_TEST__";
let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);
  const one = async <T>(q: SQL): Promise<T> => ((await db.execute(q)) as unknown as T[])[0];
  const all = async <T>(q: SQL): Promise<T[]> => (await db.execute(q)) as unknown as T[];

  const pending = (await one<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM lead_inbox WHERE status IN ('received','awaiting_lookup')`)).n;
  if (pending > 0) throw new Error(`REFUSING: lead_inbox already has ${pending} claimable row(s)`);

  const [pMob, pVoip, pUnk, pTf, pVoip2] = fictionalPhones(5);
  const phones = [pMob, pVoip, pUnk, pTf, pVoip2];
  await refuseIfPhonesInUse(db, phones);
  const types: Record<string, string> = {
    [pMob]: "mobile", [pVoip]: "voip", [pUnk]: "unknown", [pTf]: "toll_free", [pVoip2]: "voip",
  };

  const sfx = String(Date.now()).slice(-7);
  let orgId = "";
  try {
    orgId = (await one<{ id: string }>(
      sql`INSERT INTO organizations (name) VALUES (${`${MARKER} ${sfx}`}) RETURNING id`)).id;
    const keyId = (await createPartnerWithKey(db, { orgId, slug: "lt-" + sfx, name: "lt", token: "toklt" + sfx })).keyId;

    for (const p of phones) {
      await db.execute(sql`
        INSERT INTO phone_lookups (phone, line_type, source, lookup_status, looked_up_at)
        VALUES (${p}, ${types[p]}, 'manual_edit', 'complete', now())`);
      await db.execute(sql`
        INSERT INTO lead_inbox (org_id, partner_key_id, partner_slug, received_at, raw, phone_e164, interest_tag)
        VALUES (${orgId}::uuid, ${keyId}, ${"lt-" + sfx}, now() - interval '1 minute',
                ${JSON.stringify({ phone: p })}::jsonb, ${p}, 'lt')`);
    }
    const enr = await runEnrichmentBatch();
    const contacts = await all<{ id: string; phone_number: string; line_type: string }>(sql`
      SELECT id, phone_number, line_type FROM contacts WHERE org_id = ${orgId}::uuid`);
    const id = Object.fromEntries(contacts.map((c) => [c.phone_number, c.id]));
    const copied = contacts.filter((c) => c.line_type === types[c.phone_number]).length;
    bar("I1 drip intake copies the lookup's line_type onto the contact", contacts.length === 5 && copied === 5,
      `processed ${enr.processed}, contacts ${contacts.length}, matching ${copied}/5`);

    // Groups: STRICT holds mob/voip/unk/tf; OPEN holds all five. A campaign selects OPEN only.
    const mkGroup = async (name: string) => (await one<{ id: number }>(sql`
      INSERT INTO contact_groups (org_id, contact_group_id, name)
      VALUES (${orgId}::uuid, ${name + "-" + sfx}, ${name}) RETURNING id`)).id;
    const strict = await mkGroup("strict");
    const open = await mkGroup("open");
    const member = async (g: number, ps: string[]) => {
      for (const p of ps) {
        await db.execute(sql`INSERT INTO contact_contact_groups (contact_id, contact_group_id, org_id)
          VALUES (${id[p]}::uuid, ${g}, ${orgId}::uuid)`);
      }
    };
    await member(strict, [pMob, pVoip, pUnk, pTf]);
    await member(open, phones);
    const seg = (await one<{ id: number }>(sql`
      INSERT INTO segments (org_id, segment_id, name) VALUES (${orgId}::uuid, ${"lt-" + sfx}, 'lt') RETURNING id`)).id;
    for (const p of phones) {
      await db.execute(sql`INSERT INTO segment_contacts (segment_id, contact_id, org_id)
        VALUES (${seg}, ${id[p]}::uuid, ${orgId}::uuid)`);
    }

    const setStrict = (voip: boolean, unknown: boolean, status = "active") => db.execute(sql`
      UPDATE contact_groups SET allow_voip = ${voip}, allow_unknown = ${unknown}, status = ${status}
      WHERE id = ${strict}`);
    const filters = { include_no_status: true, include_opt_in: true, include_clickers: true, include_not_clicked: true };
    const groupCount = async () => (await previewAudience({
      orgId, lifecycleRules: false, segmentIds: [], contactGroupIds: [open], filters,
    })).total_matching;
    const segSet = async () => {
      const rows = await all<{ contact_id: string }>(sql`
        SELECT contact_id FROM (${await buildSegmentAudienceClause(seg, orgId)}) s`);
      return rows.map((r) => types[contacts.find((c) => c.id === r.contact_id)!.phone_number]).sort().join(",");
    };

    await setStrict(true, true);
    const base = await groupCount();
    bar("G5 both boxes checked ⇒ every type is in the audience", base === 5 && (await segSet()) === "mobile,toll_free,unknown,voip,voip",
      `group ${base}, segment ${await segSet()}`);

    await setStrict(false, false);
    const g1 = await groupCount();
    bar("G1 group side: strict group's voip + unknown leave a campaign selecting another group", g1 === 3, `got ${g1}, want 3`);
    const s1 = await segSet();
    bar("G2 segment side: same set (mobile, toll_free, the un-grouped voip)", s1 === "mobile,toll_free,voip", s1);

    // Drip routing, strict group still both-off.
    const events = await all<{ id: string; contact_id: string }>(sql`
      SELECT id, contact_id FROM lead_events WHERE org_id = ${orgId}::uuid`);
    const ev = (p: string) => events.find((e) => e.contact_id === id[p])!.id;
    const vVoip = (await evaluateLeadRouting(db, { orgId, leadEventId: ev(pVoip) }))!;
    const vUnk = (await evaluateLeadRouting(db, { orgId, leadEventId: ev(pUnk) }))!;
    bar("D1 blocked voip / unknown leads fail global line_type and are PERMANENT",
      vVoip.global.line_type === "blocked" && vUnk.global.line_type === "blocked"
        && classifyRoutingOutcome(vVoip) === "permanent" && classifyRoutingOutcome(vUnk) === "permanent",
      `voip ${vVoip.global.line_type}/${classifyRoutingOutcome(vVoip)}, unknown ${vUnk.global.line_type}/${classifyRoutingOutcome(vUnk)}`);
    const vMob = (await evaluateLeadRouting(db, { orgId, leadEventId: ev(pMob) }))!;
    const vV2 = (await evaluateLeadRouting(db, { orgId, leadEventId: ev(pVoip2) }))!;
    bar("D2 mobile and the un-grouped voip pass line_type",
      vMob.global.line_type === "pass" && vV2.global.line_type === "pass",
      `mobile ${vMob.global.line_type}, voip2 ${vV2.global.line_type}`);

    await setStrict(false, true);
    const g3 = await groupCount();
    const s3 = await segSet();
    bar("G3 only VoIP disallowed: voip out, unknown back", g3 === 4 && s3 === "mobile,toll_free,unknown,voip", `group ${g3}, segment ${s3}`);

    await setStrict(false, false, "archived");
    const g4 = await groupCount();
    bar("G4 an archived strict group blocks nothing", g4 === 5, `got ${g4}`);
  } finally {
    if (orgId) {
      const name = (await one<{ name: string } | undefined>(
        sql`SELECT name FROM organizations WHERE id = ${orgId}::uuid`))?.name ?? "";
      if (!name.includes(MARKER)) {
        console.error(`REFUSING TEARDOWN: org ${orgId} lacks the marker`);
        fail++;
      } else {
        await db.execute(sql`DELETE FROM lead_events WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_inbox WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_intake_daily WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM lead_intake_hourly WHERE org_id = ${orgId}::uuid`);
        await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
      }
    }
    const list = sql.join(phones.map((p) => sql`${p}`), sql`, `);
    await db.execute(sql`DELETE FROM phone_lookups WHERE phone IN (${list}) AND source = 'manual_edit'`);
    await db.execute(sql`DELETE FROM lookup_queue WHERE phone IN (${list})`);
    const left = await one<{ n: string }>(sql`
      SELECT ((SELECT count(*) FROM organizations WHERE id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM contact_groups WHERE org_id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM contacts WHERE org_id = ${orgId || null}::uuid)
            + (SELECT count(*) FROM phone_lookups WHERE phone IN (${list}))) AS n`);
    console.log(`\nTeardown: ${left.n} row(s) left`);
    if (Number(left.n) !== 0) fail++;
  }
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
