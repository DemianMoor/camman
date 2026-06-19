import "server-only";

import { deriveLabel, type SpamProvider, type SpamScoreResult } from "../types";

// Per-attempt timeout. Raised from 10s to give a cold classifier (e.g. a
// Cloud Run instance that scaled to zero) room to boot + load the model
// before we abort. We retry once on network/timeout failures, so the
// worst case is ~2× this — kept under the route's maxDuration=60.
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 2;
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
    // Retry once on network/timeout failures only. The common failure mode
    // is a cold instance: the first attempt warms it (and may abort on the
    // timeout), the second lands on a now-warm instance and succeeds. We do
    // NOT retry an HTTP non-2xx — the service is up and deliberately
    // erroring, so a retry just doubles latency for the same answer.
    let last: Omit<SpamScoreResult, "verdict"> | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const r = await this.attemptScore(text);
      if (!r.error || !r.retryable) return r.result;
      last = r.result;
    }
    return last!;
  }

  // One HTTP attempt. `retryable` is true for transport failures
  // (timeout/abort/network), false for a real classifier response we
  // shouldn't second-guess (non-2xx, bad payload).
  private async attemptScore(text: string): Promise<{
    result: Omit<SpamScoreResult, "verdict">;
    error: boolean;
    retryable: boolean;
  }> {
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
        return {
          result: this.failure(
            `classifier returned ${res.status}: ${body.slice(0, 200)}`,
            latencyMs,
          ),
          error: true,
          retryable: false,
        };
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
        return {
          result: this.failure(
            `classifier returned non-numeric score: ${String(raw.score)}`,
            latencyMs,
          ),
          error: true,
          retryable: false,
        };
      }
      const clamped = Math.max(0, Math.min(100, score));
      const confidence =
        typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
          ? Math.max(0, Math.min(1, raw.confidence))
          : null;
      const modelVersion =
        typeof raw.model_version === "string" ? raw.model_version : null;

      return {
        result: {
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
        },
        error: false,
        retryable: false,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      // Transport-level failure (timeout/abort/network) — worth one retry.
      return { result: this.failure(msg, latencyMs), error: true, retryable: true };
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
