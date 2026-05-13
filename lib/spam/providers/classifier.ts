import "server-only";

import { deriveLabel, type SpamProvider, type SpamScoreResult } from "../types";

const DEFAULT_TIMEOUT_MS = 10_000;
const FALLBACK_SCORE = 50; // "I don't know" — borderline; verdict will be not_spam (> 50 rule)

// Self-hosted classifier provider. Calls the Cloud Run service over HTTP.
// On any failure (network, timeout, non-2xx, parse error) returns a
// fallback shape with `error` set rather than throwing. This keeps the
// service layer's contract simple — callers always get a result, never a
// thrown exception, and the cache can still store the failure for audit.
export class SelfHostedClassifierProvider implements SpamProvider {
  readonly name = "classifier-v1";

  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts?: { url?: string; apiKey?: string; timeoutMs?: number }) {
    const url = opts?.url ?? process.env.CLASSIFIER_URL;
    const apiKey = opts?.apiKey ?? process.env.CLASSIFIER_API_KEY;
    if (!url) throw new Error("CLASSIFIER_URL is not set");
    if (!apiKey) throw new Error("CLASSIFIER_API_KEY is not set");
    this.url = url.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.timeoutMs =
      opts?.timeoutMs ??
      Number(process.env.CLASSIFIER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  }

  async score(
    text: string,
  ): Promise<Omit<SpamScoreResult, "verdict">> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.url}/score`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const latencyMs = Date.now() - start;

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return this.failure(
          `classifier returned ${res.status}: ${body.slice(0, 200)}`,
          latencyMs,
        );
      }

      // Expected shape: { score, label, confidence, model_version, model_id }
      const raw = (await res.json()) as {
        score?: unknown;
        label?: unknown;
        confidence?: unknown;
        model_version?: unknown;
      };

      const score =
        typeof raw.score === "number" ? Math.round(raw.score) : null;
      if (score === null || !Number.isFinite(score)) {
        return this.failure(
          `classifier returned non-numeric score: ${String(raw.score)}`,
          latencyMs,
        );
      }
      const clamped = Math.max(0, Math.min(100, score));
      const confidence =
        typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
          ? Math.max(0, Math.min(1, raw.confidence))
          : null;
      const modelVersion =
        typeof raw.model_version === "string" ? raw.model_version : null;

      return {
        score: clamped,
        // Derive our own label rather than trusting the remote — keeps the
        // thresholds in one place if we adjust them later.
        label: deriveLabel(clamped),
        confidence,
        provider: this.name,
        modelVersion,
        rawResponse: raw,
        latencyMs,
        error: null,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      return this.failure(msg, latencyMs);
    }
  }

  private failure(
    error: string,
    latencyMs: number,
  ): Omit<SpamScoreResult, "verdict"> {
    return {
      score: FALLBACK_SCORE,
      label: deriveLabel(FALLBACK_SCORE),
      confidence: null,
      provider: this.name,
      modelVersion: null,
      rawResponse: null,
      latencyMs,
      error,
    };
  }
}
