import { isBotUserAgent } from "@/lib/links/classify-click";

// Pure click-scoring model (no DB, no IO) — fully unit-testable. The scoring
// job enriches a click (ASN lookup, datacenter derivation) and then calls
// this to produce the numeric score + final classification + reasons.
//
// Two-tier output: a numeric `bot_score` (0-100) and a coarse
// `classification`. `bot_reasons` lists every signal that fired and is
// recorded on EVERY row — including human-scored ones — so near-misses are
// visible when the weights are retuned.
//
// Weights (approved 2026-06-03):
//   datacenter ASN ............. +60   (strongest SMS signal — real
//                                       recipients tap from residential/mobile)
//   scanner / headless UA ...... +40
//   missing user agent ......... +25   (known soft spot; expected first knob
//                                       turned — bump this if bots slip through)
//   prefetch headers ........... ⇒ classification 'prefetch' directly,
//                                  bypassing the numeric score.
// Cutoffs: score >= 70 → bot ; 40-69 → suspect ; < 40 → human.
//
// Timing (seconds_since_send) is DEFERRED — accepted in the input for
// forward-compatibility but contributes nothing yet (no send pipeline records
// a per-message send time). When minting runs at send time, add a weighted
// "implausibly fast click" branch here; nothing else changes.

export type ScoredClassification = "human" | "suspect" | "prefetch" | "bot";

export const SCORE_WEIGHTS = {
  datacenter: 60,
  scannerUa: 40,
  missingUa: 25,
} as const;

export const SCORE_CUTOFFS = {
  bot: 70,
  suspect: 40,
} as const;

export interface ScoreClickInput {
  // The inline first-pass verdict already stored on the row. If it was
  // 'prefetch', the prefetch headers fired at click time (we don't store the
  // raw headers), so the row stays 'prefetch'.
  firstPassClassification: string;
  userAgent: string | null | undefined;
  asn: number | null | undefined;
  asnOrg: string | null | undefined;
  isDatacenter: boolean | null | undefined;
  // Reserved; unused until a send pipeline records per-message send time.
  secondsSinceSend?: number | null;
}

export interface ScoreClickResult {
  score: number;
  classification: ScoredClassification;
  reasons: string[];
}

export function scoreClick(input: ScoreClickInput): ScoreClickResult {
  // Prefetch is its own bucket and bypasses numeric scoring entirely.
  if (input.firstPassClassification === "prefetch") {
    return { score: 100, classification: "prefetch", reasons: ["prefetch_headers"] };
  }

  const reasons: string[] = [];
  let score = 0;

  if (input.isDatacenter === true) {
    score += SCORE_WEIGHTS.datacenter;
    reasons.push("datacenter_asn");
  }

  const ua = (input.userAgent ?? "").trim();
  if (!ua) {
    score += SCORE_WEIGHTS.missingUa;
    reasons.push("missing_user_agent");
  } else if (isBotUserAgent(ua)) {
    score += SCORE_WEIGHTS.scannerUa;
    reasons.push("scanner_or_headless_ua");
  }

  if (score > 100) score = 100;

  const classification: ScoredClassification =
    score >= SCORE_CUTOFFS.bot
      ? "bot"
      : score >= SCORE_CUTOFFS.suspect
        ? "suspect"
        : "human";

  return { score, classification, reasons };
}
