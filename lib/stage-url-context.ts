import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { offers, utm_tags } from "@/db/schema";
import type { UtmTagForUrl } from "@/lib/stage-url";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// Server-side resolver for the inputs buildStageFullUrl needs: the offer's
// base_url / postfix, the selected sales page's URL, and the selected UTM
// tags' label/value_source in the chosen order. Also doubles as the FK
// ownership check for utm_tag_ids (jsonb can't enforce a FK). Returns
// { ok: false, invalidUtmTagId } if any selected tag isn't org-owned.

export type StageUrlContext = {
  salesPageUrl: string | null;
  postfix: string | null;
  utmTags: UtmTagForUrl[];
};

export async function loadStageUrlContext({
  orgId,
  offerId,
  salesPageLabel,
  utmTagIds,
  dbc = db,
}: {
  orgId: string;
  offerId: number | null;
  salesPageLabel: string | null;
  utmTagIds: number[];
  // Optional db/tx handle. Defaults to the module db; the send kickoff passes
  // its transaction so reads see the same snapshot as the rest of the kickoff.
  dbc?: DbOrTx;
}): Promise<
  { ok: true; ctx: StageUrlContext } | { ok: false; invalidUtmTagId: number }
> {
  let postfix: string | null = null;
  let salesPageUrl: string | null = null;

  if (offerId != null) {
    const o = await dbc
      .select({
        postfix: offers.postfix,
        sales_pages: offers.sales_pages,
      })
      .from(offers)
      .where(and(eq(offers.id, offerId), eq(offers.org_id, orgId)))
      .limit(1);
    if (o[0]) {
      postfix = o[0].postfix;
      if (salesPageLabel) {
        const sp = (o[0].sales_pages ?? []).find(
          (p) => p.label === salesPageLabel,
        );
        salesPageUrl = sp?.url ?? null;
      }
    }
  }

  let utmTags: UtmTagForUrl[] = [];
  if (utmTagIds.length > 0) {
    const rows = await dbc
      .select({
        id: utm_tags.id,
        tag_id: utm_tags.tag_id,
        value_source: utm_tags.value_source,
      })
      .from(utm_tags)
      .where(and(inArray(utm_tags.id, utmTagIds), eq(utm_tags.org_id, orgId)));
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    for (const id of utmTagIds) {
      if (!byId.has(id)) return { ok: false, invalidUtmTagId: id };
    }
    // Preserve the operator's chosen order — it's the URL param order.
    utmTags = utmTagIds.map((id) => {
      const r = byId.get(id)!;
      return { tag_id: r.tag_id, value_source: r.value_source };
    });
  }

  return { ok: true, ctx: { salesPageUrl, postfix, utmTags } };
}
