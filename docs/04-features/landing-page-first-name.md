# Feature — Landing-page first name (0230)

_Last updated: 2026-11-03_

## 1. Purpose

Lets a brand landing page greet the recipient by first name **without the name ever being in a URL**. The page already carries the recipient's `sub_id1` (appended by `/r/`, = `stage_sends.id`); its site-wide script asks this endpoint for the name. A stage opts in with **Allow first name on page**.

## 2. At a glance

| | |
|---|---|
| Column | `campaign_stages.allow_first_name_on_page` — `boolean NOT NULL DEFAULT false` ([0230](../../db/migrations/0230_stage_page_first_name.sql)) |
| UI | Stage form checkbox next to Add ZIP / State to URL, behind the same `NEXT_PUBLIC_STAGE_URL_GEO_PARAMS_UI_ENABLED` flag; tracked stages only; locks with the message format; copied by duplicate / campaign duplicate / split / behavioural split |
| Endpoint | `GET /api/public/first-name?t=<sub_id1>` — [app/api/public/first-name/route.ts](../../app/api/public/first-name/route.ts) |
| Lookup | [lib/links/page-first-name.ts](../../lib/links/page-first-name.ts) — one statement, three primary-key reads (`stage_sends`, `campaign_stages`, `contact_attributes`) |
| Name rules | `TAGS.first_name.normalize` — identical to the `{first_name}` SMS tag ([lib/messages/tags.ts](../../lib/messages/tags.ts)) |
| Not touched | `/r/`, `resolve-click.ts`, minting, kickoff, drip send — guarded by `scripts/test-page-first-name.ts` S1 |

## 3. Endpoint spec (hand-over for the brand-site script)

**URL.** Served on every host the app answers, including each short-link host:
`https://go.guidekn.com/api/public/first-name?t=<sub_id1>` — likewise `g.guidekn.com`, `gdkn.org`, `g.lumzen.co`, `sms.lumzen.co`, `g.fitsyou.net`, `sms.fitsyou.net`, `go.blogcascade.com`. Use the brand's own short-link host.

**Request.** `GET`, query param `t` = the page URL's `sub_id1` value as-is. No headers, no cookies, no body (a plain `fetch(url)` — no preflight; `OPTIONS` is answered anyway).

**Response.** Always `200`, `Content-Type: application/json`, one of:
- `{"first_name":"Maria"}` — the token is a sent, tracked message ≤ 14 days old, its stage has the box ticked, and the contact has a usable name. Already title-cased (`mary-JANE` → `Mary-Jane`), ASCII letters / space / `'` / `-` only.
- `{"first_name":null}` — **every** other case: unknown / malformed / missing token, send older than 14 days or not sent, box unticked, no or unusable name (junk like `n/a`, digits, untransliterable letters), over the rate limit, DB error or > 1 s. The response never says which.

**Headers.** `Cache-Control: no-store, private, max-age=0`, `Vary: Origin`, `X-Content-Type-Options: nosniff`. `Access-Control-Allow-Origin` echoes the request `Origin` only when it is exactly one of `https://guidekn.com`, `https://www.guidekn.com`, `https://lumzen.co`, `https://www.lumzen.co`, `https://fitsyou.net`, `https://www.fitsyou.net`, `https://blogcascade.com`, `https://www.blogcascade.com` (https only). No `Allow-Credentials`.

**Timing / edge cases.**
- Every failure runs the same query (a malformed token is swapped for an id that matches nothing), so hit and miss take similar time; rate-limited calls answer without a query.
- Server-side budget 1 s, then `null`. The page script should still treat a network error / non-200 / non-JSON as "no name" and render the nameless version.
- Rate limit: 20 requests in a burst per IP, refilling 1 every 3 s, **per server instance** (in-memory; owner ruling — the token's randomness is the real defence).
- The window is 14 days from `stage_sends.sent_at`. Manual-mode stages (pasted short URL) have no `sub_id1`, so never return a name.
- The name is not logged server-side. The page must mask it for session recorders (Clarity) — the brand-site script does this.

## 4. Security notes

- `sub_id1` is a random v4 UUID (`randomUUID()` / `gen_random_uuid()` on every send path) — not enumerable.
- Accepted exposure (owner, 2026-11-03): anyone holding a landing-page URL inside the window can read that one recipient's first name; CORS limits browsers, not server-side callers.

## 5. Verification

- `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-page-first-name.ts` — DB cases (rolled back), fail-open, route headers/CORS/rate limit, source guards.
- `/r/` unchanged: `scripts/test-stage-url-geo-params.ts`, and the read-only prod `scripts/verify-stage-url-geo-identical.ts`.
