import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/lib/links/resolve-click";
import { TAGS } from "@/lib/messages/tags";

// Landing-page first-name lookup (0230). The page holds the recipient's sub_id1
// (= stage_sends.id, a random v4 UUID) and asks GET /api/public/first-name for
// the name, so the name itself never travels in a URL.
//
// Owner rulings 2026-11-03: exposure to whoever holds the page URL is accepted
// with sub_id1 + a 14-day window; rate limit is the per-instance in-memory
// bucket; the brand sites mask the name for Clarity.

export const PAGE_FIRST_NAME_WINDOW_DAYS = 14;

/** Origins allowed to read the response (CORS). Exact match, https only. */
export const PAGE_FIRST_NAME_ORIGINS: ReadonlySet<string> = new Set(
  ["guidekn.com", "lumzen.co", "fitsyou.net", "blogcascade.com"].flatMap((d) => [
    `https://${d}`,
    `https://www.${d}`,
  ]),
);

// Past this the page gets the empty answer; a slow DB never hangs the page.
export const PAGE_FIRST_NAME_BUDGET_MS = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A malformed token runs the SAME query against an id that matches nothing, so
// every failure takes the same path and similar time.
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * The recipient's first name, normalized exactly like the {first_name} tag, or
 * null. Null whenever: the token isn't a sent message, the send is older than
 * the window, its stage hasn't ticked "Allow first name on page", or the name
 * is missing / junk. Callers must not distinguish these cases.
 */
export async function lookupPageFirstName(
  dbc: DbOrTx,
  token: string | null | undefined,
): Promise<string | null> {
  const id = token && UUID_RE.test(token) ? token.toLowerCase() : NIL_UUID;
  const rows = (await dbc.execute(sql`
    SELECT ca.first_name
    FROM stage_sends ss
    JOIN campaign_stages s ON s.id = ss.stage_id AND s.org_id = ss.org_id
    JOIN contact_attributes ca ON ca.contact_id = ss.contact_id AND ca.org_id = ss.org_id
    WHERE ss.id = ${id}::uuid
      AND ss.status = 'sent'
      AND ss.link_id IS NOT NULL
      AND ss.sent_at > now() - make_interval(days => ${PAGE_FIRST_NAME_WINDOW_DAYS}::int)
      AND s.allow_first_name_on_page
  `)) as unknown as { first_name: string | null }[];
  return TAGS.first_name.normalize(rows[0]?.first_name ?? null);
}

/** lookupPageFirstName, but any error or a budget overrun yields null. */
export function lookupPageFirstNameFailOpen(
  lookup: () => Promise<string | null>,
  budgetMs: number = PAGE_FIRST_NAME_BUDGET_MS,
): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), budgetMs);
    let p: Promise<string | null>;
    try {
      p = lookup();
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      (name) => {
        clearTimeout(timer);
        resolve(name);
      },
      (err) => {
        clearTimeout(timer);
        // Never log the token or the name.
        console.error("lookupPageFirstName failed", err instanceof Error ? err.message : "unknown");
        resolve(null);
      },
    );
  });
}
