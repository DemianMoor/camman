// scripts/test-message-formats-admin.ts — message format admin rules (M2.*) on the
// PREVIEW DB, rolled back, plus the permission set (pure).
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-message-formats-admin.ts
import "./_env-preload";
import { requirePreviewDb } from "./_require-preview-db"; // MUST be second
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { can, type Role } from "@/lib/permissions";
import { OPERATOR_ROUTE_MAP } from "@/lib/authz/route-map";
import {
  countLiveStagesUsingFormat, createFormat, listFormats, makeDefaultFormat, updateFormat,
} from "@/lib/messages/format-admin";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
class Rollback extends Error {}
const VALID = "{creative_text}<new_row>{url} — {stop_text}";

async function main() {
  console.log(`Target DB: ${requirePreviewDb().label}\n`);

  console.log("Permissions (pure)");
  const roles: Role[] = ["viewer", "operator", "manager", "admin", "owner"];
  bar("M2.1 message_formats.view: every role", roles.every((r) => can(r, "message_formats.view")));
  bar("M2.2 message_formats.manage: manager/admin/owner only — NOT operator, NOT viewer",
    JSON.stringify(roles.map((r) => can(r, "message_formats.manage"))) === JSON.stringify([false, false, true, true, true]));
  bar("M2.3 operator may only GET the list route",
    JSON.stringify(OPERATOR_ROUTE_MAP["message-formats/list"]?.methods) === JSON.stringify(["GET"])
      && OPERATOR_ROUTE_MAP["message-formats"] === null
      && OPERATOR_ROUTE_MAP["message-formats/[id]"] === null
      && OPERATOR_ROUTE_MAP["message-formats/[id]/make-default"] === null);

  console.log("\nAdmin rules (preview, rolled back)");
  try {
    await db.transaction(async (tx) => {
      const camp = (await tx.execute(sql`SELECT id, org_id FROM campaigns ORDER BY id LIMIT 1`)) as unknown as { id: number; org_id: string }[];
      const { id: campaignId, org_id: orgId } = camp[0];

      const badTok = await createFormat(tx, orgId, { name: "Bad", template: "{first_name} {creative_text}{url}{stop_text}" });
      bar("M2.4 create: a tag token in a template ⇒ 400 unknown_token", !badTok.ok && badTok.error.status === 400 && badTok.error.reason === "unknown_token");
      const badBlk = await createFormat(tx, orgId, { name: "Bad", template: "{creative_text}{url}" });
      bar("M2.5 create: missing {stop_text} ⇒ 400 missing_block", !badBlk.ok && badBlk.error.reason === "missing_block");

      const made = await createFormat(tx, orgId, { name: "T4 test", template: VALID });
      bar("M2.6 create: valid ⇒ enabled, not default", made.ok && made.row.is_enabled && !made.row.is_default);
      if (!made.ok) throw new Rollback();
      const f = made.row.id;

      await tx.execute(sql`UPDATE campaigns SET status = 'draft' WHERE id = ${campaignId}`);
      await tx.execute(sql`INSERT INTO campaign_stages (org_id, campaign_id, message_format_id) VALUES (${orgId}, ${campaignId}, ${f})`);
      bar("M2.7 live count = 1 for a draft stage using it", (await countLiveStagesUsingFormat(tx, orgId, f)) === 1);

      const inUse = await updateFormat(tx, orgId, f, { is_enabled: false });
      bar("M2.8 in-use disable refused ⇒ 409 format_in_use, details.count = 1",
        !inUse.ok && inUse.error.status === 409 && inUse.error.reason === "format_in_use" && inUse.error.details?.count === 1);

      const edit = await updateFormat(tx, orgId, f, { template: "{creative_text} {brand}<new_row>{url}<new_row>{stop_text}", name: "T4 renamed" });
      bar("M2.9 editing an in-use template is allowed (future renders only)", edit.ok && edit.row.name === "T4 renamed");
      const editBad = await updateFormat(tx, orgId, f, { template: "{creative_text}" });
      bar("M2.10 edit to an invalid template ⇒ 400 missing_block", !editBad.ok && editBad.error.reason === "missing_block");

      await tx.execute(sql`UPDATE campaigns SET status = 'completed' WHERE id = ${campaignId}`);
      bar("M2.11 a completed campaign's stage is not live", (await countLiveStagesUsingFormat(tx, orgId, f)) === 0);
      const off = await updateFormat(tx, orgId, f, { is_enabled: false });
      bar("M2.12 disabling an unused format succeeds", off.ok && !off.row.is_enabled);

      const defNow = (await tx.execute(sql`SELECT id FROM message_formats WHERE org_id = ${orgId} AND is_default`)) as unknown as { id: number }[];
      const offDef = await updateFormat(tx, orgId, defNow[0].id, { is_enabled: false });
      bar("M2.13 disabling the default ⇒ 409 default_format", !offDef.ok && offDef.error.status === 409 && offDef.error.reason === "default_format");
      const mkOff = await makeDefaultFormat(tx, orgId, f);
      bar("M2.14 making a disabled format default ⇒ 409 format_disabled", !mkOff.ok && mkOff.error.reason === "format_disabled");

      await updateFormat(tx, orgId, f, { is_enabled: true });
      const mk = await makeDefaultFormat(tx, orgId, f);
      const defs = (await tx.execute(sql`SELECT id FROM message_formats WHERE org_id = ${orgId} AND is_default`)) as unknown as { id: number }[];
      bar("M2.15 make-default moves the single default", mk.ok && defs.length === 1 && defs[0].id === f);

      const other = (await tx.execute(sql`SELECT id FROM organizations WHERE id <> ${orgId}::uuid LIMIT 1`)) as unknown as { id: string }[];
      const cross = await updateFormat(tx, other[0].id, f, { name: "x" });
      bar("M2.16 another org's format ⇒ 404", !cross.ok && cross.error.status === 404);

      const list = await listFormats(tx, orgId);
      bar("M2.17 list is org-scoped, carries live_stage_count, default first",
        list.length >= 4 && list.every((r) => r.org_id === orgId) && list[0].is_default && list.every((r) => typeof r.live_stage_count === "number"));
      const fresh = (await tx.execute(sql`INSERT INTO organizations (name) VALUES ('msgfmt-admin-fresh') RETURNING id`)) as unknown as { id: string }[];
      const freshList = await listFormats(tx, fresh[0].id);
      bar("M2.18 a brand-new org's list is seeded on first read (T1 default + T2 + T3)",
        freshList.length === 3 && freshList[0].is_default && freshList[0].name.startsWith("T1"), JSON.stringify(freshList.map((f) => f.name)));
      // Review fix: creating a format as an unseeded org's FIRST action must not
      // leave it with formats but no default (ensure_message_formats would then
      // RAISE on every stage insert and list read).
      const virgin = (await tx.execute(sql`INSERT INTO organizations (name) VALUES ('msgfmt-admin-virgin') RETURNING id`)) as unknown as { id: string }[];
      const firstCreate = await createFormat(tx, virgin[0].id, { name: "Mine", template: VALID });
      const virginList = await listFormats(tx, virgin[0].id);
      const virginStage = (await tx.execute(sql`
        INSERT INTO campaign_stages (org_id, campaign_id) VALUES (${virgin[0].id}, ${campaignId}) RETURNING message_format_id`)) as unknown as { message_format_id: number }[];
      bar("M2.19 createFormat as an unseeded org's first action ⇒ seeds T1-T3 first; list + stage insert still work",
        firstCreate.ok && virginList.length === 4 && virginList[0].is_default && virginList[0].name.startsWith("T1")
          && virginStage[0].message_format_id === virginList[0].id, JSON.stringify(virginList.map((f) => f.name)));
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  console.log(fail === 0 ? "\nALL GREEN (rolled back)" : `\n${fail} FAILED (rolled back)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
