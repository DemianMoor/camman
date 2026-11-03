# Feature — Stage URL ZIP / State params (0229)

_Last updated: 2026-11-03_

## 1. Purpose
Lets a landing page personalize its headline with the recipient's ZIP and state. Two per-stage checkboxes next to the Full URL, **Add ZIP to URL** and **Add State to URL**, make the `/r/<code>` redirect append `&zip=<5 digits>` and/or `&st=<USPS code>` for each recipient, and the same values again as `&sub_id_7=` (ZIP) / `&sub_id_8=` (state) for the tracker. First use: the ACA2 drip feed. Card: [1amdve2a8u1](https://app.clickup.com/t/1amdve2a8u1).

## 2. Where the params are added: at REDIRECT time, never at mint
| Piece | File |
|---|---|
| Columns | `campaign_stages.url_add_zip`, `url_add_state` — `boolean NOT NULL DEFAULT false` ([0229](../../db/migrations/0229_stage_url_geo_params.sql)) |
| Normalize + append (pure, client-safe) | [lib/links/geo-params.ts](../../lib/links/geo-params.ts) `appendGeoParams`, `previewLandingUrl`, `lookupGeoParamsFailOpen` |
| DB lookup + redirect | [lib/links/resolve-click.ts](../../lib/links/resolve-click.ts) `lookupGeoParams`, `resolveAndLogClick` |
| Form | [components/campaigns/stage-form.tsx](../../components/campaigns/stage-form.tsx), under the Full URL input |
| Lock | `PATCH /api/campaigns/[campaignId]/stages/[stageId]` → `409 url_params_locked_after_send` |

The final URL is `<destination>?sub_id3=…&sub_id1=<send_token>&zip=75201&st=TX&sub_id_7=75201&sub_id_8=TX` (sub_id_7/sub_id_8 added 2026-11-03, with the underscore — renamed from sub_id7/sub_id8 the same day, #424 → this PR; same value, normalization and fail-open as zip/st), built in the same place as `sub_id1`. Because the stored `link_destinations` URL never changes:
- **Unticked = byte-identical to today**, both the minted URL and the redirect.
- **The SMS length is unchanged.** The body carries only the `/r/` short link.
- **No shape-rule changes.** `GUIDEKN_DEST_RE`, `validateBrandLpShape` and the `landing_url_ok` trigger check saved stage URLs and `link_destinations` inserts. The redirect output never goes through them.
- **The Landing Page Results report doesn't split.** Its key is parsed from the minted `link_destinations.url` ([landing-page-report.md §2](landing-page-report.md)).

## 3. Rules (owner, 2026-11-03)
- **Only ZIP and state, ever** (as `zip`/`st` and their `sub_id_7`/`sub_id_8` copies). Nothing else from the contact goes in a URL.
- **Values are read at click time** from `contact_attributes` (`zip`, `state`) and passed through the `{zip}` / `{state}` tag normalizers ([lib/messages/tags.ts](../../lib/messages/tags.ts)). ZIP+4 becomes 5 digits, a state name becomes the USPS code, and only the 50 states plus DC are accepted.
- **A missing or invalid value omits that param for that recipient.** The click still redirects. This is unlike creative tags, which skip the recipient.
- **A hand-edited Full URL that already carries `zip=`, `st=`, `sub_id_7=` or `sub_id_8=`** keeps its own value for that key. `appendUrlParam` doesn't append a key that's already present.
- **Fail-open.** The lookup is a separate statement that runs alongside the clicks insert, capped at `GEO_LOOKUP_BUDGET_MS` (150 ms). If it errors, times out or finds nothing, the redirect is exactly today's (`sub_id1` only).
- **Lock = message-format lock** (`stageFormatLocked`). A regular stage locks once materialized; a drip stage locks at its first sent message. Echoing the stored value is always accepted. On a live drip stage, create a new stage instead.
- **Copies keep the flags:** stage duplicate, campaign duplicate, A/B split variants and behavioural lanes. A brand-new stage starts unchecked.
- **Manual-mode campaigns** (`link_mode='manual'`) send a pasted short URL that never passes through `/r/`. The boxes are disabled there.

## 4. UI flag (dark launch)
`NEXT_PUBLIC_STAGE_URL_GEO_PARAMS_UI_ENABLED`: anything except `"true"` means OFF. OFF hides the checkboxes and preview, and the stage payload carries no flag, so stored values can't change from the UI. The redirect is **not** gated: it follows the stage row, which is `false` everywhere until someone ticks a box with the flag on. The preview shows `…&sub_id1=<recipient id>&zip=75201&st=TX&sub_id_7=75201&sub_id_8=TX` (sample values).

## 5. Verify
- `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-stage-url-geo-params.ts`: pure normalization, fail-open (forced throw, hang, empty), the real lookup and redirect on the preview DB (rolled back), and source guards confirming the mint paths are untouched.
- `npx tsx --conditions=react-server scripts/verify-stage-url-geo-identical.ts`: **read only**. Takes the newest link of every stage and asserts the new redirect equals main's (`appendUrlParam(dest, "sub_id1", token)`), using the real lookup SQL on real rows. Prod run due after 0229 is applied.
