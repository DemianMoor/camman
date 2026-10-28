// Server-side helpers for a stage's message shape (0216): exactly one of
// campaign_stages.message_format_id / custom_text is set.

import { sql } from "drizzle-orm";
import type { db } from "@/db/client";
import { validateCustomText } from "./format";
import { FORMAT_LOCKED_TEXT } from "@/lib/stages/lock-copy";

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

export type StageFormatDecision =
  | { ok: true; set: Partial<StageFormatColumns> }
  | {
      ok: false;
      status: 400 | 403 | 409;
      message: string;
      reason: "custom_message_locked" | "custom_text_missing_required_block" | "format_locked_after_send" | "format_unavailable";
      field: "custom_text" | "message_format_id";
    };

/**
 * Decide a stage create/edit of its message shape (spec B3/B4, R4/R5). PURE.
 * The stage form ECHOES every field, so only a value that differs from the
 * stored one is a change — an echo is never refused.
 *   • custom text needs stages.custom_message (operator+): setting it, editing
 *     it and leaving it for a format all require it;
 *   • custom text must contain {creative_text}, {url} and {stop_text};
 *   • a format must be enabled, active and the org's own (`formatUsable`);
 *   • once the stage is locked (stageFormatLocked) the shape cannot change
 *     (all stages — By Format attribution is per stage).
 * `current` is null on create.
 */
export { stageFormatLocked } from "@/lib/stages/format-lock";

export function decideStageFormatChange(i: {
  current: StageFormatColumns | null;
  input: { message_format_id?: number | null; custom_text?: string | null };
  canCustomMessage: boolean;
  /** stageFormatLocked(...) for an existing stage; false on create. */
  locked: boolean;
  /** Is input.message_format_id enabled + active in this org? Ignored when not sent. */
  formatUsable: boolean;
}): StageFormatDecision {
  const cur = i.current ?? { message_format_id: null, custom_text: null };
  const wantsCustom = i.input.custom_text != null;
  const wantsFormat = !wantsCustom && i.input.message_format_id != null;
  if (!wantsCustom && !wantsFormat) return { ok: true, set: {} };
  if (wantsCustom ? i.input.custom_text === cur.custom_text : i.input.message_format_id === cur.message_format_id) {
    return { ok: true, set: {} };
  }
  if ((wantsCustom || cur.custom_text != null) && !i.canCustomMessage) {
    return {
      ok: false, status: 403, reason: "custom_message_locked", field: "custom_text",
      message: "You don't have permission to write a custom message.",
    };
  }
  if (wantsCustom) {
    const bad = validateCustomText(i.input.custom_text!);
    if (bad) {
      return {
        ok: false, status: 400, reason: bad.code, field: "custom_text",
        message: `Custom text must contain {creative_text}, {url} and {stop_text} — ${bad.detail} is missing.`,
      };
    }
  } else if (!i.formatUsable) {
    return {
      ok: false, status: 400, reason: "format_unavailable", field: "message_format_id",
      message: "That message format is disabled or does not exist.",
    };
  }
  if (i.locked) {
    return {
      ok: false, status: 409, reason: "format_locked_after_send", field: wantsCustom ? "custom_text" : "message_format_id",
      message: `This stage's messages are already prepared or sent, so its message format is locked. ${FORMAT_LOCKED_TEXT}.`,
    };
  }
  return wantsCustom
    ? { ok: true, set: { message_format_id: null, custom_text: i.input.custom_text! } }
    : { ok: true, set: { message_format_id: i.input.message_format_id!, custom_text: null } };
}

/** Is this format enabled, active and owned by the org? */
export async function isFormatUsable(dbc: DbOrTx, orgId: string, formatId: number): Promise<boolean> {
  const r = (await dbc.execute(sql`
    SELECT 1 FROM message_formats
    WHERE id = ${formatId} AND org_id = ${orgId}::uuid AND is_enabled AND status = 'active'
  `)) as unknown as unknown[];
  return r.length > 0;
}
