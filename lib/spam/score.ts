import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { spam_scores } from "@/db/schema";

import { hashText, normalizeText } from "./normalize";
import { SelfHostedClassifierProvider } from "./providers/classifier";
import {
  deriveLabel,
  deriveVerdict,
  type SpamProvider,
  type SpamScoreResult,
} from "./types";

// Provider registry. Add new providers by implementing SpamProvider and
// registering a factory here. Selection is driven by the SPAM_PROVIDER
// env var.
const PROVIDER_FACTORIES: Record<string, () => SpamProvider> = {
  classifier: () => new SelfHostedClassifierProvider(),
  // openai: () => new OpenAISpamProvider(),  // future
};

// Lazy-cache the provider instance per Node process. Construction validates
// env vars so we want it to fail fast on first use, not on import.
let cachedProvider: SpamProvider | null = null;
function getProvider(): SpamProvider {
  if (cachedProvider) return cachedProvider;
  const key = process.env.SPAM_PROVIDER ?? "classifier";
  const factory = PROVIDER_FACTORIES[key];
  if (!factory) {
    throw new Error(
      `Unknown SPAM_PROVIDER='${key}'. Available: ${Object.keys(PROVIDER_FACTORIES).join(", ")}`,
    );
  }
  cachedProvider = factory();
  return cachedProvider;
}

// Test seam: lets the test script swap in a mock provider without needing
// real env vars or network. Production code never calls this.
export function __setProviderForTesting(provider: SpamProvider | null) {
  cachedProvider = provider;
}

export type ScoreMessageResult = SpamScoreResult & {
  cached: boolean;
  textHash: string;
};

// Main entry point. Returns a cached score on hit, otherwise calls the
// configured provider and inserts the result. Empty/whitespace text
// short-circuits to ham with no DB write.
export async function scoreMessage(
  orgId: string,
  text: string,
  opts?: { force?: boolean; userId?: string },
): Promise<ScoreMessageResult> {
  const normalized = normalizeText(text);
  if (normalized.length === 0) {
    return {
      score: 0,
      label: "ham",
      verdict: "not_spam",
      confidence: null,
      provider: "noop",
      modelVersion: null,
      rawResponse: null,
      latencyMs: 0,
      error: null,
      cached: false,
      textHash: "",
    };
  }

  const provider = getProvider();
  const textHash = hashText(text);

  if (!opts?.force) {
    const hit = await db
      .select()
      .from(spam_scores)
      .where(
        and(
          eq(spam_scores.org_id, orgId),
          eq(spam_scores.text_hash, textHash),
          eq(spam_scores.provider, provider.name),
        ),
      )
      .limit(1);
    if (hit[0]) {
      const row = hit[0];
      return {
        score: row.score,
        label: row.label as SpamScoreResult["label"],
        verdict: deriveVerdict(row.score),
        confidence: row.confidence,
        provider: row.provider,
        modelVersion: row.model_version,
        rawResponse: row.raw_response,
        latencyMs: row.latency_ms ?? 0,
        error: row.error,
        cached: true,
        textHash,
      };
    }
  }

  const result = await provider.score(text);
  // Defensive: ensure label matches the score we ended up with.
  const label = deriveLabel(result.score);
  const verdict = deriveVerdict(result.score);

  // Cache the result. ON CONFLICT DO NOTHING handles the rare race where
  // two concurrent requests for the same (org, text, provider) both miss
  // and both try to insert — the first wins, the second skips silently.
  await db
    .insert(spam_scores)
    .values({
      org_id: orgId,
      text_hash: textHash,
      text_length: text.length,
      score: result.score,
      label,
      confidence: result.confidence,
      provider: result.provider,
      model_version: result.modelVersion,
      raw_response: (result.rawResponse as Record<string, unknown>) ?? null,
      latency_ms: result.latencyMs,
      error: result.error,
    })
    .onConflictDoNothing({
      target: [
        spam_scores.org_id,
        spam_scores.text_hash,
        spam_scores.provider,
      ],
    });

  return {
    ...result,
    label,
    verdict,
    cached: false,
    textHash,
  };
}
