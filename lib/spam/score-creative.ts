import "server-only";

import { and, eq, sql as drizzleSql } from "drizzle-orm";

import { db } from "@/db/client";
import { creatives } from "@/db/schema";

import { scoreMessage } from "./score";
import { deriveVerdict } from "./types";

// Result of scoring a creative — same shape we mirror onto the row plus
// the cache hit flag for the response.
export interface CreativeSpamResult {
  spam_score: number | null;
  spam_label: "ham" | "spam" | null;
  spam_scored_at: string | null;
  spam_model_id: string | null;
  spam_score_error: string | null;
  cached: boolean;
}

// Score a creative's text and mirror the result onto its row. Returns
// the mirrored fields plus `cached` so the caller can surface that to
// the UI.
//
// Errors don't propagate: a provider failure surfaces as spam_score_error
// with score/label NULL on the row. This matches the contract of
// scoreMessage which also doesn't throw.
//
// Safe to call inside or outside a transaction. Pass a transaction handle
// to keep the update atomic with the surrounding work; without one, the
// row update runs on the top-level pool.
export async function scoreAndPersistCreative(opts: {
  creativeId: number;
  orgId: string;
  text: string;
  tx?: Pick<typeof db, "update" | "execute">;
}): Promise<CreativeSpamResult> {
  const runner = opts.tx ?? db;
  const trimmed = (opts.text ?? "").trim();
  // Empty text is treated as "ham" with score 0 — matches scoreMessage's
  // own short-circuit. We still write to the row so the column reflects
  // the latest state.
  if (trimmed.length === 0) {
    await runner
      .update(creatives)
      .set({
        spam_score: 0,
        spam_label: "ham",
        spam_scored_at: drizzleSql`now()`,
        spam_model_id: null,
        spam_score_error: null,
      })
      .where(
        and(
          eq(creatives.id, opts.creativeId),
          eq(creatives.org_id, opts.orgId),
        ),
      );
    return {
      spam_score: 0,
      spam_label: "ham",
      spam_scored_at: new Date().toISOString(),
      spam_model_id: null,
      spam_score_error: null,
      cached: false,
    };
  }

  const result = await scoreMessage(opts.orgId, opts.text);

  // Failure: keep score/label NULL on the row, persist the error.
  if (result.error) {
    await runner
      .update(creatives)
      .set({
        spam_score: null,
        spam_label: null,
        spam_scored_at: drizzleSql`now()`,
        spam_model_id: null,
        spam_score_error: result.error,
      })
      .where(
        and(
          eq(creatives.id, opts.creativeId),
          eq(creatives.org_id, opts.orgId),
        ),
      );
    return {
      spam_score: null,
      spam_label: null,
      spam_scored_at: new Date().toISOString(),
      spam_model_id: null,
      spam_score_error: result.error,
      cached: result.cached,
    };
  }

  // Success: derive the binary label from the score (cache stores the
  // 3-bucket label, the row stores the binary verdict).
  const verdict = deriveVerdict(result.score);
  const binaryLabel: "ham" | "spam" = verdict === "spam" ? "spam" : "ham";
  await runner
    .update(creatives)
    .set({
      spam_score: result.score,
      spam_label: binaryLabel,
      spam_scored_at: drizzleSql`now()`,
      spam_model_id: result.modelVersion ?? result.provider,
      spam_score_error: null,
    })
    .where(
      and(
        eq(creatives.id, opts.creativeId),
        eq(creatives.org_id, opts.orgId),
      ),
    );

  return {
    spam_score: result.score,
    spam_label: binaryLabel,
    spam_scored_at: new Date().toISOString(),
    spam_model_id: result.modelVersion ?? result.provider,
    spam_score_error: null,
    cached: result.cached,
  };
}
