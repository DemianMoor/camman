# Claude Code Brief — Step 5: CamMan ← Keitaro 5-minute poll

**Repo:** CamMan. **Goal:** every 5 minutes, pull clicks + conversions from Keitaro's Admin API, grouped by campaign, and upsert into CamMan so the CRM shows live per-campaign (and per-customer) results. This delivers the original objective: real-time campaign monitoring inside CamMan.

---

## Confirmed environment (use exactly)

- **API base URL:** `https://admin.gdkn.org` (dedicated admin/API host — stable, independent of brand tracking domains; never hardcode a brand tracking domain here).
- **Auth:** header `Api-Key: <key>` (Keitaro also accepts `Authorization: Bearer <key>`). Store the key in env var **`KEITARO_API_KEY`** — never in code.
- **Edition:** Expert (Admin API available). ✅
- **Verified working call:** `GET https://admin.gdkn.org/admin_api/v1/campaigns` returns the campaign list (id, alias, name, state, token, domain).

> **SECURITY:** the key `f7b090f41a0a98df73b6f54f9b6cf998` was shared in plaintext during setup. **Rotate it** in Keitaro (Users → Admin API Keys) after this build and put the new value in `KEITARO_API_KEY`.

## Slot mapping (AUTHORITATIVE — overrides any stale examples in the contract)

- **`sub_id_3` = campaign ID** ← this is the **canonical grouping key** for the poll.
- **`sub_id_5` = customer / click ID** (unique per person in per-recipient mode; empty in bulk).
- `sub_id_4` = page slug (reporting only).
- Conversions match clicks by Keitaro's own click **token** (`aff_click_id`); once matched, the click's `sub_id_3`/`sub_id_5`/`sub_id_4` are already on the conversion — so grouping the report by `sub_id_3` yields clicks *and* conversions per campaign in one pass.

---

## Endpoints

1. **Campaign mapping** — `GET /admin_api/v1/campaigns`
   Map Keitaro `id` / `alias` / `name` → the CamMan campaign record. (Your live one: id `3`, alias `kinzeno`.)

2. **Report builder** — `POST /admin_api/v1/report/build`
   This is the workhorse. **Confirm the exact request body before coding it** — do NOT guess the parameter/metric names. Two ways, use both:
   - Open the **Swagger reference** at `https://admin-api.docs.keitaro.io` (log in with the API key) → find the report-build schema.
   - In the Keitaro panel, build the equivalent report in the UI, then read the real request in **DevTools → Network → Fetch/XHR → the report request → Payload**. Keitaro routes all panel actions through the Admin API, so this shows the precise grouping/metric keys this version uses.

   Expected shape (verify each field against the above):
   ```
   POST https://admin.gdkn.org/admin_api/v1/report/build
   Headers: Api-Key: $KEITARO_API_KEY  ·  Content-Type: application/json
   Body:
   {
     "range":    { "from": "<window start>", "to": "<now>", "timezone": "America/New_York" },
     "grouping": ["sub_id_3"],
     "metrics":  ["clicks", "campaign_unique_clicks", "conversions", "sales", "leads", "revenue", "epc"],
     "filters":  []
   }
   ```
   The internal metric keys (`clicks`, `campaign_unique_clicks`, `sale_conversions`, `leads`, `revenue`, `epc`, etc.) MUST be confirmed from Swagger/DevTools — names vary and a wrong key silently returns nothing.

---

## Metric naming (map Keitaro → CamMan reporting terms)

Use the agreed naming when storing/displaying:
`Raw Clicks` · `Clean Clicks` (bot/prefetch-filtered) · `CTR` · `Checkouts (CI)` · `Checkout Rate` · `Sales (CV)` · `Sales CR` · `EPC`.
Map Keitaro's raw vs unique/clean click metrics to Raw/Clean; conversions with status `lead`→Checkouts, status `sale`→Sales (confirm status semantics against how Sweeply reports). EPC is the primary creative/campaign ranking metric.

## Grouping & storage (per the contract)

- **Aggregate layer (always):** one upserted row per campaign per day — `(campaign_id, date, raw_clicks, clean_clicks, checkouts, sales, revenue, epc, …)`. This is the universal cross-brand view.
- **Detail layer (per-recipient campaigns only):** additionally pull grouped by `sub_id_5` (customer) and store per-customer rows. Skip for bulk campaigns (shared/empty `sub_id_5`).
- A campaign's type (`per_recipient` | `bulk`) on the CamMan side decides whether the detail pull runs.
- Map every report row's `sub_id_3` back to the CamMan campaign via the campaign-mapping call.

## Cron & idempotency

- **Every 5 minutes** (Vercel cron `*/5`; account is on Pro). Keitaro report data refreshes ~every minute, so 5-min cadence is comfortable.
- **Window:** pull a **rolling window** (e.g. last 3 days), not just "today" — conversions arrive late (the affiliate fires the postback minutes-to-hours after the click), so a multi-day window catches late sales attaching to earlier clicks. Clicks for older days are stable; re-reading them is cheap.
- **Idempotent UPSERT, never append.** Each poll fetches current cumulative totals per campaign/day and overwrites the stored row (last-write-wins on the aggregate). Re-polling must not double-count. Key the upsert on `(campaign_id, date)` for aggregates and `(campaign_id, customer_id, date)` for detail rows.

## Verification

You already have real data in Keitaro to test against: a live click on the `kinzeno` campaign and a matched test conversion.

1. Run the poll once (manually trigger the cron handler).
2. Confirm CamMan now shows the **kinzeno** campaign with: Raw/Clean Clicks ≥ the clicks you fired, and the test Sale + payout reflected.
3. Re-run the poll → confirm totals **update in place, not duplicate** (idempotency).
4. Confirm a campaign with no activity shows zeros, not an error.

## Constraints / gotchas (CamMan stack)

- Supabase **transaction pooler** (port 6543, `?prepare=false`), `America/New_York` timezone, Drizzle — per existing CamMan conventions.
- Keep all Keitaro calls pointed at the single host `https://admin.gdkn.org`; adding brand tracking domains later does NOT change the poll.
- `admin.gdkn.org` should stay DNS-only in Cloudflare (or have a WAF exception for `/admin_api/`), so the every-5-min programmatic calls aren't challenged by bot rules.
- Fail-safe: a failed poll must log and retry next cycle, never crash the cron or partial-write inconsistent rows (wrap each campaign's upsert; don't let one bad row abort the batch).
