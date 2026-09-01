import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { campaign_stages, creative_offers, creatives, stage_sends } from "@/db/schema";

// Creative versioning (ClickUp 869et3vm1, Phase 3).
//
// Editing the BODY of a creative that has already sent creates a NEW creative
// instead of mutating the old one. The original is frozen — its text can never
// change again.
//
// ⚠️ WITHOUT THIS THE PROVEN GATE IS DECORATIVE. "Proven" is derived from send
// history keyed on creative_id. Edit the text in place and the new copy inherits
// the old copy's history: something nobody has ever sent is instantly proven,
// and the unproven-volume warning never fires for it. Versioning is not a nicety
// bolted onto the gate — it is the thing that makes the gate mean anything.
//
// It also protects reporting. Every stage, link and stage_send row points at a
// creative_id; rewriting the text under them silently re-labels history, so a
// report about "what we sent last Tuesday" would start describing words that did
// not exist last Tuesday.

/** Has this creative ever produced a send? */
export async function creativeHasSends(
  orgId: string,
  creativeId: number,
): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stage_sends)
    .innerJoin(campaign_stages, eq(campaign_stages.id, stage_sends.stage_id))
    .where(
      and(
        eq(stage_sends.org_id, orgId),
        eq(campaign_stages.creative_id, creativeId),
        eq(stage_sends.status, "sent"),
      ),
    )
    .limit(1);
  return (rows[0]?.n ?? 0) > 0;
}

export interface ForkResult {
  newCreativeId: number;
  newSlug: string;
  frozenCreativeId: number;
}

/**
 * Fork a creative: copy it with the new text, leave the original untouched.
 *
 * Returns the NEW id so the caller can tell the user which creative they are now
 * looking at — silently redirecting them to a different row without saying so
 * would be worse than refusing the edit.
 *
 * The copy deliberately does NOT carry spam scores forward: the score describes
 * a specific string, and the string just changed. It starts unscored, which is
 * also what makes the inline spam strip re-run.
 */
export async function forkCreative(opts: {
  orgId: string;
  creativeId: number;
  newText: string;
  actorUserId: string;
}): Promise<ForkResult> {
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(creatives)
      .where(
        and(eq(creatives.id, opts.creativeId), eq(creatives.org_id, opts.orgId)),
      )
      .limit(1);
    if (!source) throw new Error("creative not found");

    // Slug must stay unique org-wide. `-v2`, `-v3`… reads as a version chain in
    // any list that sorts by slug, which is how an operator will look for it.
    const base = source.slug.replace(/-v\d+$/, "");
    const existing = await tx
      .select({ slug: creatives.slug })
      .from(creatives)
      .where(and(eq(creatives.org_id, opts.orgId), sql`${creatives.slug} LIKE ${base + "%"}`));
    let n = 2;
    const taken = new Set(existing.map((e) => e.slug));
    while (taken.has(`${base}-v${n}`)) n++;
    const newSlug = `${base}-v${n}`;

    const [created] = await tx
      .insert(creatives)
      .values({
        org_id: opts.orgId,
        slug: newSlug,
        text: opts.newText,
        quality: source.quality,
        sequence_placement: source.sequence_placement,
        funnel_stage: source.funnel_stage,
        applies_to_all_offers: source.applies_to_all_offers,
        // allow_multi_segment is a compliance field and does NOT carry forward —
        // same reasoning as the duplicate route, which resets it deliberately.
        status: "active",
      })
      .returning({ id: creatives.id, slug: creatives.slug });

    // Offer junctions carry over: the fork targets the same offers, and losing
    // them would make the new creative invisible in every offer-filtered picker.
    const offers = await tx
      .select({ offer_id: creative_offers.offer_id })
      .from(creative_offers)
      .where(eq(creative_offers.creative_id, opts.creativeId));
    if (offers.length > 0) {
      await tx.insert(creative_offers).values(
        offers.map((o) => ({
          org_id: opts.orgId,
          creative_id: created.id,
          offer_id: o.offer_id,
        })),
      );
    }

    return {
      newCreativeId: created.id,
      newSlug: created.slug,
      frozenCreativeId: opts.creativeId,
    };
  });
}
