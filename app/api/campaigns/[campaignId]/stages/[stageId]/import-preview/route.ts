import { and, eq, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { db } from "@/db/client";
import {
  campaign_stages,
  campaigns,
  stage_result_rows,
} from "@/db/schema";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { CSV_MAX_BYTES, parseCsv } from "@/lib/imports/parse-csv";
import {
  deriveOutcome,
  OUTCOME_PRIORITY,
  type RowOutcome,
} from "@/lib/imports/outcome";
import { can } from "@/lib/permissions";
import {
  mappingColumnsSchema,
  statusValueMapSchema,
} from "@/lib/validators/result-import-mappings";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const previewSchema = z.object({
  csv_content: z.string().min(1),
  mapping: mappingColumnsSchema,
  status_value_map: statusValueMapSchema,
});

const SAMPLE_LIMIT_PER_OUTCOME = 5;

// Compute the would-be import summary WITHOUT touching the DB. The client
// uses this for the Step 3 preview of ResultsImportForm. We still hit the DB
// to count phones already present in stage_result_rows for this stage so we
// can show the user how many rows will be idempotent-skipped.
export async function POST(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ campaignId: string; stageId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "result_imports.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { campaignId, stageId } = await params;
  const cid = parseId(campaignId);
  const sid = parseId(stageId);
  if (cid === null || sid === null) {
    return apiError(400, "Invalid id", API_ERROR_CODES.VALIDATION);
  }

  // Verify stage ↔ campaign ↔ org.
  const ownership = await db
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
  if (!ownership[0]) {
    return apiError(404, "Stage not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "stage",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }
  const parsed = previewSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  const { csv_content, mapping, status_value_map } = parsed.data;
  // Use Buffer.byteLength to enforce the 25MB cap on multi-byte content too.
  if (Buffer.byteLength(csv_content, "utf-8") > CSV_MAX_BYTES) {
    return apiError(
      400,
      "CSV exceeds 25MB limit",
      API_ERROR_CODES.VALIDATION,
      { reason: "csv_too_large" },
    );
  }

  const { rows, submitted } = parseCsv(csv_content, mapping);

  // Walk the parsed rows once, collapsing duplicates by phone number
  // using OUTCOME_PRIORITY (same logic the import endpoint applies). The
  // per-bucket and sample counts below reflect the post-collapse state
  // so the preview matches what the import will actually store.
  let invalidPhone = 0;
  let parsedCount = 0;
  type PreviewWinner = {
    outcome: RowOutcome;
    raw: Record<string, string>;
  };
  const winners = new Map<string, PreviewWinner>();
  for (const r of rows) {
    if (r.phone_number === null) {
      invalidPhone++;
      continue;
    }
    parsedCount++;
    const o = deriveOutcome(r, status_value_map ?? undefined);
    const existing = winners.get(r.phone_number);
    if (
      !existing ||
      OUTCOME_PRIORITY[o.outcome] > OUTCOME_PRIORITY[existing.outcome]
    ) {
      winners.set(r.phone_number, { outcome: o.outcome, raw: r.raw });
    }
  }

  const byOutcome: Record<RowOutcome, number> = {
    delivered: 0,
    failed: 0,
    optout: 0,
    clicker: 0,
    scrubbed: 0,
    bounced: 0,
    noop: 0,
  };
  const samples: Record<
    RowOutcome,
    Array<{
      outcome: RowOutcome;
      phone_number: string;
      raw: Record<string, string>;
    }>
  > = {
    delivered: [],
    failed: [],
    optout: [],
    clicker: [],
    scrubbed: [],
    bounced: [],
    noop: [],
  };
  const phonesForDedup: string[] = [];
  for (const [phone, winner] of winners) {
    byOutcome[winner.outcome]++;
    phonesForDedup.push(phone);
    if (samples[winner.outcome].length < SAMPLE_LIMIT_PER_OUTCOME) {
      samples[winner.outcome].push({
        outcome: winner.outcome,
        phone_number: phone,
        raw: winner.raw,
      });
    }
  }
  const uniqueNumbers = winners.size;
  const eventsCollapsed = parsedCount - uniqueNumbers;

  // Count how many of the unique phones already exist in stage_result_rows
  // for this stage. These will be idempotent-skipped on actual import.
  // Cap the IN list to avoid massive query plans; chunk if huge.
  const existingPhones = new Set<string>();
  const dedupChunk = 5000;
  for (let i = 0; i < phonesForDedup.length; i += dedupChunk) {
    const chunk = phonesForDedup.slice(i, i + dedupChunk);
    if (chunk.length === 0) continue;
    const found = await db
      .select({ phone_number: stage_result_rows.phone_number })
      .from(stage_result_rows)
      .where(
        and(
          eq(stage_result_rows.stage_id, sid),
          inArray(stage_result_rows.phone_number, chunk),
        ),
      );
    for (const f of found) existingPhones.add(f.phone_number);
  }
  const existingInDb = existingPhones.size;

  const flatSamples = [
    ...samples.delivered,
    ...samples.failed,
    ...samples.optout,
    ...samples.clicker,
    ...samples.scrubbed,
    ...samples.bounced,
    ...samples.noop,
  ];

  return NextResponse.json({
    submitted,
    parsed: parsedCount,
    invalid_phone: invalidPhone,
    // Post-priority-dedup unique-phone count. Per-bucket counts in
    // by_outcome sum to this number.
    unique_numbers: uniqueNumbers,
    // Number of CSV rows dropped because the same phone already had a
    // higher- or equal-priority outcome from another row.
    events_collapsed: eventsCollapsed,
    by_outcome: byOutcome,
    sample_rows: flatSamples,
    existing_in_db: existingInDb,
  });
}
