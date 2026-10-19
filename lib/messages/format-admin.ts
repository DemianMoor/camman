// Message format administration (0216) — the rules behind /api/message-formats.
// Routes are thin wrappers so these rules are testable directly
// (scripts/test-message-formats-admin.ts).
//
// Rules (spec B1/B3/B7):
//   • a template must pass validateTemplate (blocks only; creative_text/url/stop_text);
//   • the default is always enabled — it cannot be disabled, and a disabled
//     format cannot be made default (the DB CHECK backs both);
//   • disabling a format that LIVE stages use is refused with their count — never
//     a silent fallback;
//   • editing a template is allowed while in use: it applies to future renders
//     only (regular rows are frozen at materialization; drip renders at send).

import { and, desc, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { message_formats, type MessageFormat } from "@/db/schema";
import { validateTemplate } from "./format";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface FormatAdminError {
  status: 400 | 404 | 409;
  message: string;
  reason: "unknown_token" | "missing_block" | "not_found" | "format_in_use" | "default_format" | "format_disabled";
  details?: { count?: number; token?: string };
}
export type FormatAdminResult = { ok: true; row: MessageFormat } | { ok: false; error: FormatAdminError };

const notFound: FormatAdminResult = {
  ok: false,
  error: { status: 404, message: "Message format not found", reason: "not_found" },
};

function templateError(template: string): FormatAdminResult | null {
  const e = validateTemplate(template);
  if (!e) return null;
  return {
    ok: false,
    error: {
      status: 400,
      message: e.code === "unknown_token"
        ? `${e.detail} is not a format block. Use {brand}, {creative_text}, {url}, {stop_text} and <new_row>.`
        : `A format must contain ${e.detail}.`,
      reason: e.code,
      details: { token: e.detail },
    },
  };
}

/**
 * Stages that would render with this format if they sent from now on: not
 * archived, on a draft/active/paused campaign, and either drip (renders at
 * send) or a regular stage not yet materialized (rows freeze the text).
 */
export async function countLiveStagesUsingFormat(dbc: DbOrTx, orgId: string, formatId: number): Promise<number> {
  const r = (await dbc.execute(sql`
    SELECT count(*)::int AS n
    FROM campaign_stages s
    JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.org_id = ${orgId}::uuid
      AND s.message_format_id = ${formatId}
      AND s.status <> 'archived' AND s.archived_at IS NULL
      AND c.status IN ('draft', 'active', 'paused')
      AND (c.type = 'drip' OR s.materialized_at IS NULL)
  `)) as unknown as { n: number }[];
  return Number(r[0]?.n ?? 0);
}

export async function listFormats(dbc: DbOrTx, orgId: string): Promise<(MessageFormat & { live_stage_count: number })[]> {
  const rows = await dbc
    .select()
    .from(message_formats)
    .where(and(eq(message_formats.org_id, orgId), eq(message_formats.status, "active")))
    .orderBy(desc(message_formats.is_default), asc(message_formats.id));
  return Promise.all(rows.map(async (r) => ({ ...r, live_stage_count: await countLiveStagesUsingFormat(dbc, orgId, r.id) })));
}

async function loadOwned(dbc: DbOrTx, orgId: string, id: number): Promise<MessageFormat | null> {
  const rows = await dbc
    .select()
    .from(message_formats)
    .where(and(eq(message_formats.id, id), eq(message_formats.org_id, orgId), eq(message_formats.status, "active")))
    .limit(1);
  return rows[0] ?? null;
}

export async function createFormat(dbc: DbOrTx, orgId: string, input: { name: string; template: string }): Promise<FormatAdminResult> {
  const bad = templateError(input.template);
  if (bad) return bad;
  const [row] = await dbc
    .insert(message_formats)
    .values({ org_id: orgId, name: input.name, template: input.template })
    .returning();
  return { ok: true, row };
}

export async function updateFormat(
  dbc: DbOrTx,
  orgId: string,
  id: number,
  patch: { name?: string; template?: string; is_enabled?: boolean },
): Promise<FormatAdminResult> {
  const current = await loadOwned(dbc, orgId, id);
  if (!current) return notFound;
  if (patch.template !== undefined) {
    const bad = templateError(patch.template);
    if (bad) return bad;
  }
  if (patch.is_enabled === false && current.is_enabled) {
    if (current.is_default) {
      return { ok: false, error: { status: 409, message: "The default format can't be disabled. Make another format the default first.", reason: "default_format" } };
    }
    const count = await countLiveStagesUsingFormat(dbc, orgId, id);
    if (count > 0) {
      return {
        ok: false,
        error: {
          status: 409,
          message: `${count} live stage${count === 1 ? "" : "s"} use this format. Switch them to another format first.`,
          reason: "format_in_use",
          details: { count },
        },
      };
    }
  }
  const [row] = await dbc
    .update(message_formats)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.template !== undefined ? { template: patch.template } : {}),
      ...(patch.is_enabled !== undefined ? { is_enabled: patch.is_enabled } : {}),
      updated_at: new Date(),
    })
    .where(and(eq(message_formats.id, id), eq(message_formats.org_id, orgId)))
    .returning();
  return { ok: true, row };
}

export async function makeDefaultFormat(dbc: DbOrTx, orgId: string, id: number): Promise<FormatAdminResult> {
  const current = await loadOwned(dbc, orgId, id);
  if (!current) return notFound;
  if (!current.is_enabled) {
    return { ok: false, error: { status: 409, message: "Enable this format before making it the default.", reason: "format_disabled" } };
  }
  if (current.is_default) return { ok: true, row: current };
  // Clear the old default first: the partial unique index allows one per org.
  await dbc
    .update(message_formats)
    .set({ is_default: false, updated_at: new Date() })
    .where(and(eq(message_formats.org_id, orgId), eq(message_formats.is_default, true)));
  const [row] = await dbc
    .update(message_formats)
    .set({ is_default: true, updated_at: new Date() })
    .where(and(eq(message_formats.id, id), eq(message_formats.org_id, orgId)))
    .returning();
  return { ok: true, row };
}
