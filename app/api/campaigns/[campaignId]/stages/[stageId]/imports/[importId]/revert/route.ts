import { and, eq, inArray, isNull, ne, sql as drizzleSql } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import {
  campaign_stages,
  campaigns,
  clickers,
  opt_outs,
  stage_result_rows,
  stage_results_imports,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Revert an import. Transactional.
//
// Cross-import opt-out / clicker preservation rule
// ------------------------------------------------
// When this import created or referenced an opt_out or clicker, the row's
// created_opt_out_id / created_clicker_id points to it. On revert we look
// at each result row and decide whether to delete the referenced opt_out /
// clicker:
//   - If ANY OTHER non-reverted stage_result_rows row (excluding rows
//     belonging to imports that have reverted_at set, AND excluding the
//     rows we're about to delete from THIS import) still references the
//     same opt_out / clicker id → leave it.
//   - Otherwise → delete the opt_out / clicker.
//
// The check runs BEFORE we delete this import's rows, with a NOT IN
// against the soon-to-be-deleted ids so we don't false-positive against
// ourselves.
export async function POST(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{
      campaignId: string;
      stageId: string;
      importId: string;
    }>;
  },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role, user } = auth;

  if (!can(role, "result_imports.revert")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId, stageId, importId } = await params;
  const cid = parseId(campaignId);
  const sid = parseId(stageId);
  const iid = parseId(importId);
  if (cid === null || sid === null || iid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  // Verify ownership chain.
  const owns = await db
    .select({ id: campaign_stages.id })
    .from(campaign_stages)
    .innerJoin(campaigns, eq(campaigns.id, campaign_stages.campaign_id))
    .where(
      and(
        eq(campaign_stages.id, sid),
        eq(campaign_stages.campaign_id, cid),
        eq(campaign_stages.org_id, orgId),
      ),
    )
    .limit(1);
  if (!owns[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "stage",
    });
  }

  const result = await db.transaction(async (tx) => {
    const importRows = await tx
      .select()
      .from(stage_results_imports)
      .where(
        and(
          eq(stage_results_imports.id, iid),
          eq(stage_results_imports.stage_id, sid),
          eq(stage_results_imports.org_id, orgId),
        ),
      )
      .limit(1);
    if (!importRows[0]) {
      return {
        kind: "not_found" as const,
      };
    }
    const importRow = importRows[0];
    if (importRow.reverted_at !== null) {
      return { kind: "already_reverted" as const };
    }

    // Collect this import's result rows (including their created_opt_out_id
    // / created_clicker_id references and their own ids so we can exclude
    // self in the "still referenced elsewhere" check).
    const myRows = await tx
      .select({
        id: stage_result_rows.id,
        created_opt_out_id: stage_result_rows.created_opt_out_id,
        created_clicker_id: stage_result_rows.created_clicker_id,
      })
      .from(stage_result_rows)
      .where(eq(stage_result_rows.import_id, iid));

    const myRowIds = myRows.map((r) => r.id);
    const optOutIds = Array.from(
      new Set(
        myRows
          .map((r) => r.created_opt_out_id)
          .filter((x): x is number => x !== null),
      ),
    );
    const clickerIds = Array.from(
      new Set(
        myRows
          .map((r) => r.created_clicker_id)
          .filter((x): x is number => x !== null),
      ),
    );

    // For each opt_out id, check if any OTHER non-reverted row still
    // references it. We exclude rows in this import (myRowIds) and rows
    // whose import has reverted_at set.
    const toDeleteOptOuts: number[] = [];
    if (optOutIds.length > 0) {
      for (const ooId of optOutIds) {
        const conditions = [
          eq(stage_result_rows.created_opt_out_id, ooId),
          // Exclude our own about-to-go-away rows. inArray with empty
          // would be a no-op, but we guard above.
          ...(myRowIds.length > 0
            ? [
                drizzleSql`${stage_result_rows.id} NOT IN (${drizzleSql.raw(myRowIds.join(","))})`,
              ]
            : []),
        ];
        const others = await tx
          .select({
            id: stage_result_rows.id,
            import_id: stage_result_rows.import_id,
          })
          .from(stage_result_rows)
          .innerJoin(
            stage_results_imports,
            eq(stage_results_imports.id, stage_result_rows.import_id),
          )
          .where(
            and(
              ...conditions,
              isNull(stage_results_imports.reverted_at),
              ne(stage_results_imports.id, iid),
            ),
          )
          .limit(1);
        if (others.length === 0) toDeleteOptOuts.push(ooId);
      }
    }

    const toDeleteClickers: number[] = [];
    if (clickerIds.length > 0) {
      for (const clId of clickerIds) {
        const conditions = [
          eq(stage_result_rows.created_clicker_id, clId),
          ...(myRowIds.length > 0
            ? [
                drizzleSql`${stage_result_rows.id} NOT IN (${drizzleSql.raw(myRowIds.join(","))})`,
              ]
            : []),
        ];
        const others = await tx
          .select({ id: stage_result_rows.id })
          .from(stage_result_rows)
          .innerJoin(
            stage_results_imports,
            eq(stage_results_imports.id, stage_result_rows.import_id),
          )
          .where(
            and(
              ...conditions,
              isNull(stage_results_imports.reverted_at),
              ne(stage_results_imports.id, iid),
            ),
          )
          .limit(1);
        if (others.length === 0) toDeleteClickers.push(clId);
      }
    }

    // Subtract from the stage's running counters. Mirror the import: a late
    // import only ever moved late_click_count (every other *_added is 0 and
    // it never added to sms_count), so smsAdded is 0 when reverting one.
    if (importRow.processed_rows > 0) {
      const smsAdded =
        importRow.clicker_phase === "late" ? 0 : importRow.processed_rows;
      await tx
        .update(campaign_stages)
        .set({
          sms_count: drizzleSql`${campaign_stages.sms_count} - ${smsAdded}`,
          delivered_count: drizzleSql`${campaign_stages.delivered_count} - ${importRow.delivered_added}`,
          opt_out_count: drizzleSql`${campaign_stages.opt_out_count} - ${importRow.optouts_added}`,
          click_count: drizzleSql`${campaign_stages.click_count} - ${importRow.clickers_added}`,
          late_click_count: drizzleSql`${campaign_stages.late_click_count} - ${importRow.late_clickers_added}`,
          scrubbed_count: drizzleSql`${campaign_stages.scrubbed_count} - ${importRow.scrubbed_added}`,
          bounced_count: drizzleSql`${campaign_stages.bounced_count} - ${importRow.bounced_added}`,
          total_cost: drizzleSql`${campaign_stages.total_cost} - ${importRow.total_cost_added}`,
        })
        .where(
          and(
            eq(campaign_stages.id, sid),
            eq(campaign_stages.org_id, orgId),
          ),
        );
    }

    // Hard-delete this import's stage_result_rows. They CASCADE off the
    // import too — we could rely on that and just delete the import — but
    // we want to preserve the import row for audit, so delete the rows
    // explicitly.
    await tx.delete(stage_result_rows).where(eq(stage_result_rows.import_id, iid));

    // Now safely delete the opt_outs / clickers we identified. The FK from
    // stage_result_rows had ON DELETE SET NULL, but we already deleted the
    // referencing rows above, so the constraint is moot. opt_out_brands
    // and opt_out_providers CASCADE off opt_outs.
    if (toDeleteOptOuts.length > 0) {
      await tx
        .delete(opt_outs)
        .where(
          and(
            eq(opt_outs.org_id, orgId),
            inArray(opt_outs.id, toDeleteOptOuts),
          ),
        );
    }
    if (toDeleteClickers.length > 0) {
      await tx
        .delete(clickers)
        .where(
          and(
            eq(clickers.org_id, orgId),
            inArray(clickers.id, toDeleteClickers),
          ),
        );
    }

    // Mark the import as reverted.
    const [updated] = await tx
      .update(stage_results_imports)
      .set({
        reverted_at: drizzleSql`now()`,
        reverted_by_user_id: user.id,
      })
      .where(eq(stage_results_imports.id, iid))
      .returning();

    return {
      kind: "ok" as const,
      import: updated,
      removed_opt_outs: toDeleteOptOuts.length,
      removed_clickers: toDeleteClickers.length,
    };
  });

  if (result.kind === "not_found") {
    return apiError(404, "Import not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "import",
    });
  }
  if (result.kind === "already_reverted") {
    return apiError(
      409,
      "Import was already reverted",
      API_ERROR_CODES.CONFLICT,
      { reason: "already_reverted" },
    );
  }
  return NextResponse.json({
    import: result.import,
    removed_opt_outs: result.removed_opt_outs,
    removed_clickers: result.removed_clickers,
  });
}
