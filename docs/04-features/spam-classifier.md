# Feature — Spam Classifier

_Last updated: 2026-06-19_

## 1. Purpose
Score SMS creative text 0–100 for spamminess via a pluggable provider abstraction, currently backed by a self-hosted **SMS Spam Classifier** service on Cloud Run. Results are cached append-only and surfaced inline in the creative editor so operators can avoid carrier-filtered copy.

## 2. Key concepts / entities
- Provider abstraction: [`lib/spam/`](../../lib/spam/) — `types.ts` (interface), `providers/classifier.ts`, `normalize.ts`, `score.ts`, `score-creative.ts`.
- Cache table `spam_scores` (UNIQUE `org_id, text_hash, provider`).
- Mirror columns on `creatives` (`spam_score`, `spam_label`, `spam_scored_at`, `spam_model_id`, `spam_score_error`) for fast list rendering without a join.

## 3. How it works

### Provider interface
```ts
interface SpamProvider {
  readonly name: string;
  score(text: string): Promise<Omit<SpamScoreResult, "verdict">>;
}
```
Providers register in a factory map keyed by `SPAM_PROVIDER` env (only `classifier` exists in v1). Future providers (OpenAI, on-device) implement the same interface.

### Classifier HTTP contract (`providers/classifier.ts`)
- `POST ${CLASSIFIER_URL}/score`, headers `Content-Type: application/json` + `X-API-Key: ${CLASSIFIER_API_KEY}`.
- Request `{ text }` · Response `{ score: 0–100, label?, confidence?, model_version? }`.
- Per-attempt timeout `CLASSIFIER_TIMEOUT_MS` (default 25000, raised from 10000). On any failure the service layer returns a fallback with `error` set — **it never throws**.
- **Retry once on transport failures.** A timeout / abort / network error is retried a single time (`MAX_ATTEMPTS = 2`); an HTTP non-2xx or bad payload is **not** retried (the service answered deliberately). The common cause is a Cloud Run instance that scaled to zero: the first attempt warms it, the second lands warm. The route sets `export const maxDuration = 60` so ~2× the per-attempt timeout fits inside the function budget.
- **Cold-start mitigation.** The root cause of "new creatives fail to score" is Cloud Run scaling the classifier to zero — the first request after idle pays a model-load cold start that blew the old 10s ceiling. Options to eliminate it: run the classifier always-on (self-hosted / `min-instances=1`) so the model stays resident, or keep a warming ping alive. Moving the service to an always-on host is a one-env-var change app-side (`CLASSIFIER_URL`) — the HTTP contract is unchanged.

### Two derived classifications (single 0–100 score)
| Output | Rule | Use |
|--------|------|-----|
| Internal label | `0–30 ham` / `31–70 suspicious` / `71–100 spam` | analytics, future warn-before-activate gating |
| Binary verdict | `score > 50 ⇒ spam`, else `not_spam` | the user-facing yes/no |

Both are returned in every API response; **verdict is derived at the service layer, not stored**.

### Cache behavior (`score.ts`)
- Keyed `(org_id, text_hash, provider)`. Re-scoring the same text against the same provider = cache hit.
- Append-only: `ON CONFLICT … DO NOTHING`. `force=true` re-runs the provider but the unique constraint blocks an overwrite, so it's effectively a **no-op against an existing row** (revisited if scheduled re-scoring is added).
- **Failures are NOT cached.** A failed score (fallback 50 + `error` set) is transient — usually a cold/unreachable classifier. Caching it would pin that text to "50 (fallback)" permanently, since the append-only constraint blocks a later real score from overwriting it. `scoreMessage` skips the insert when `result.error` is set, so the next check (after the classifier warms up) actually re-scores. Only successful scores are cached. The `creatives` mirror columns still record the error (`spam_score`/`spam_label` NULL, `spam_score_error` set) so a failed save is visible.

### Normalization (`normalize.ts`) — MUST match Python
NFKC → lowercase → trim → collapse whitespace → SHA-256. **Byte-for-byte identical** to the classifier's `src/data/normalize.py`; divergence silently doubles cost by missing the cache across the boundary.

### When scoring runs
- **Button-triggered inline:** `POST /api/spam/score` from the shared `<SpamCheckStrip>`.
- **Auto-on-save:** `score-creative.ts` scores a creative when its text is saved (inside the creative POST/PATCH transaction), mirroring results onto the `creatives` columns. A dedicated `/rescore` endpoint re-runs it.
- **Listing does NOT score** — the creatives list endpoint joins the cache read-only; the stage creative picker shows the cached color-dot + number.

### Permissions
`spam.view` (any member, cache reads) vs `spam.score` (operator+, the potentially-costly action). Mirrors the RLS policy.

## 4. Data it reads/writes
- Writes `spam_scores` (append) + `creatives` spam columns (on save/rescore).
- Reads `spam_scores` cache; classifier service over HTTP.

## 5. UI surface
- `components/spam/spam-check-strip.tsx` — the only interactive entry point: a button below the textarea in `CreativeForm` and on each `BulkCreativeForm` row. There is **no standalone debug page**.
- A scoring failure (fallback + `error`) renders as **"Couldn't score — try Re-check"** (amber), not as a fake `50 / NOT SPAM` verdict, so the operator knows to retry rather than trusting a bogus score.
- The stage creative picker renders the cached score dot + number per option.

## 6. Rules & edge cases
- `creatives_spam_score_check` (0–100) and `creatives_spam_label_check` (`ham`/`spam`) CHECKs; `spam_scores_label_check` allows the 3-way `ham/suspicious/spam`.
- The mirror columns are a denormalized cache; `spam_scores` remains the cross-creative source of truth.

## 7. Extension points / limitations
- Add a provider: implement `SpamProvider`, register in the factory, set `SPAM_PROVIDER`.
- `force=true` currently can't overwrite a cached row (append-only constraint) — a known limitation.
- No scheduled re-scoring.
