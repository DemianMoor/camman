// Server-side helpers for a stage's message shape (0216): exactly one of
// campaign_stages.message_format_id / custom_text is set.

import { sql } from "drizzle-orm";
import { db } from "@/db/client";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface StageFormatColumns {
  message_format_id: number | null;
  custom_text: string | null;
}

/**
 * The shape a stage DERIVED from `src` (duplicate, split sibling, behavioural
 * lane, drip follow-up child) starts with. Custom text is copied as-is. A
 * format is copied only while it is still enabled and active — a new stage may
 * only pick an enabled format (spec B3) — otherwise both are NULL and the
 * BEFORE INSERT trigger fills the org default.
 *
 * Every derived insert site must use this (scripts/test-stage-format-copy-guard.ts).
 */
export async function inheritedStageFormat(
  dbc: DbOrTx,
  orgId: string,
  src: StageFormatColumns,
): Promise<StageFormatColumns> {
  if (src.custom_text != null) return { message_format_id: null, custom_text: src.custom_text };
  if (src.message_format_id == null) return { message_format_id: null, custom_text: null };
  const usable = (await dbc.execute(sql`
    SELECT 1 FROM message_formats
    WHERE id = ${src.message_format_id} AND org_id = ${orgId}::uuid
      AND is_enabled AND status = 'active'
  `)) as unknown as unknown[];
  return { message_format_id: usable.length > 0 ? src.message_format_id : null, custom_text: null };
}
