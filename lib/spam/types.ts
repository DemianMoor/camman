// Spam scoring types + threshold helpers.
//
// Two layers of classification surface from a single 0-100 score:
//   * Internal label (ham/suspicious/spam) — three buckets, used for
//     analytics and the eventual "warn before activate" gating UX.
//   * Binary verdict (spam/not_spam) — user-facing yes/no, derived at
//     display time from the same score.
//
// Both are returned in every API response. Thresholds are hardcoded
// constants here in 8a; per-org configurable thresholds can come later.

export type SpamLabel = "ham" | "suspicious" | "spam";
export type SpamVerdict = "spam" | "not_spam";

export interface SpamScoreResult {
  score: number;
  label: SpamLabel;
  verdict: SpamVerdict;
  confidence: number | null;
  provider: string;
  modelVersion: string | null;
  rawResponse: unknown;
  latencyMs: number;
  error: string | null;
}

export interface SpamProvider {
  readonly name: string;
  // Verdict is intentionally computed in the service layer, not in the
  // provider — it's a UI concern (binary cutoff) that the provider
  // shouldn't need to know about.
  score(text: string): Promise<Omit<SpamScoreResult, "verdict">>;
}

export function deriveLabel(score: number): SpamLabel {
  if (score <= 30) return "ham";
  if (score <= 70) return "suspicious";
  return "spam";
}

export function deriveVerdict(score: number): SpamVerdict {
  return score > 50 ? "spam" : "not_spam";
}
