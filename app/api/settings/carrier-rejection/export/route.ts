import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { buildExportFilename, streamCsvResponse } from "@/lib/csv/stream-export";
import { can } from "@/lib/permissions";

// CSV of the numbers that currently meet the carrier-rejection rule
// (ClickUp 1amdve2850v, PR 3) — the same set as the live count on Settings >
// Sending, whether or not the toggle is on. Contact-level data, so it needs
// contacts.export. Partners come from the contact's lead events (drip intake),
// groups from its contact-group membership.

export const maxDuration = 60;

type Row = {
  phone: string;
  partners: string | null;
  contact_groups: string | null;
  hard_count: number;
  soft_count: number;
  last_rejected_at: string;
  last_code: string;
  last_provider: string;
};

export async function GET() {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;
  if (!can(role, "contacts.export")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  // ~25K rows at most today: one statement, then streamed.
  const rows = (await db.execute(sql`
    SELECT
      p.phone,
      (SELECT string_agg(DISTINCT pt.name, '; ' ORDER BY pt.name)
         FROM lead_events e
         JOIN partner_keys k ON k.id = e.partner_key_id
         JOIN partners pt ON pt.id = k.partner_id
        WHERE e.org_id = p.org_id AND e.contact_id = c.id) AS partners,
      (SELECT string_agg(DISTINCT g.name, '; ' ORDER BY g.name)
         FROM contact_contact_groups ccg
         JOIN contact_groups g ON g.id = ccg.contact_group_id
        WHERE ccg.contact_id = c.id AND ccg.org_id = p.org_id) AS contact_groups,
      p.hard_count, p.soft_count, p.last_rejected_at, p.last_code, p.last_provider
    FROM carrier_rejected_phones p
    LEFT JOIN contacts c ON c.org_id = p.org_id AND c.phone_number = p.phone
    WHERE p.org_id = ${orgId}::uuid
    ORDER BY p.last_rejected_at DESC, p.phone
  `)) as unknown as Row[];

  return streamCsvResponse({
    filename: buildExportFilename("carrier-rejected-numbers"),
    columns: [
      { key: "phone", label: "Phone" },
      { key: "partners", label: "Partner" },
      { key: "contact_groups", label: "Contact groups" },
      { key: "hard_count", label: "Hard rejections" },
      { key: "soft_count", label: "Soft rejections (window)" },
      { key: "last_rejected_at", label: "Last rejection (UTC)" },
      { key: "last_code", label: "Last code" },
      { key: "last_provider", label: "Last provider" },
    ],
    rowSource: (async function* () {
      yield* rows;
    })(),
    rowMapper: (r) => ({ ...r, last_rejected_at: new Date(r.last_rejected_at) }),
  });
}
