# Claude Code Brief — Step 5b: Split visits vs offer-redirects in the Keitaro poll

**Repo:** CamMan.
**Goal:** the poll currently groups Keitaro's report by `day` + `sub_id_3` only, so it **cannot distinguish landing-page VISITS from OFFER REDIRECTS** — both carry the same `sub_id_3` (stage tracking id) and Keitaro merges them into one click count. Add the **campaign dimension** so visits and redirects are stored as **separate counts per stage**, enabling the funnel: Clickers → Offer Redirect → Sales.

---

## Confirmed data facts (verified in the Keitaro Click log)

- Every click carries `sub_id_3` = stage tracking id (e.g. `8_62_061226_2_s2_c126`), which maps to `campaign_stages.tracking_id` → stage → campaign. (This mapping already works.)
- **Two kinds of Keitaro campaign** fire clicks for the same stage:
  - **VISIT campaign** — alias **`gk-lp-visits`** (currently campaign id 13). Fires when a visitor LANDS on `/lp/<slug>`. → **"Clickers."**
  - **OFFER/redirect campaigns** — named per offer (e.g. `Kinzeno - 14508`, `Lulutox - 13759`, `Novubrain+ - 14524`), affiliate network Sweeply.pro. Fire when a visitor clicks through to the offer. → **"Offer Redirect."**
- **Conversions (sales)** attach to the **offer** campaigns (via Sweeply postback), never the visit campaign.
- Many visit rows are **bot-flagged** in Keitaro — so the surfaced count must be **clean** (bot/prefetch-filtered) clicks.

## Classification rule (binding)

- Keitaro campaign **alias `gk-lp-visits`** → its clicks are **VISITS (Clickers)**.
- **Any other** Keitaro campaign → its clicks are **OFFER REDIRECTS**, and its conversions are **SALES**.
- Classify by the campaign **alias/name** (`gk-lp-visits`), **NOT** a hardcoded numeric id — the alias is rebuild-safe; the id changes if the campaign is ever recreated.

## Poll changes

1. **Grouping:** add the campaign dimension to the `/admin_api/v1/report/build` call → group by `day` + `sub_id_3` + **campaign**. Confirm the exact campaign grouping key (`campaign_id` / `campaign`) against the live Swagger (`admin-api.docs.keitaro.io`) or the panel's DevTools network call — do not guess.
2. **Resolve** each row's `sub_id_3` → CamMan stage (stage_id, **stage name**, campaign_id, **campaign name**). Unmatched `sub_id_3` → unmatched bucket as today.
3. **Classify & route** each row's metrics by Keitaro campaign alias:
   - alias `gk-lp-visits` → add clicks to the stage's **visit** counts (raw + clean).
   - else → add clicks to the stage's **offer-redirect** counts (raw + clean); add conversions/revenue to **sales**/revenue.
4. **Store** per `(org_id, stage_id, stat_date)` — SEPARATE columns:
   - `visit_clicks_raw`, `visit_clicks_clean` (Clickers)
   - `redirect_clicks_raw`, `redirect_clicks_clean` (Offer Redirect)
   - `sales`, `revenue`, `cost`
   - Add migration **0062** for the new columns. Preserve the existing idempotent UPSERT on `(org_id, stage_id, stat_date)`.
5. **Surface CamMan campaign name + stage name** as resolved fields on the result (for the Reports UI), not just IDs.

## Metric semantics

- **Clickers** = visit-campaign **clean** clicks (bot/prefetch excluded).
- **Offer Redirect** = offer-campaign **clean** clicks.
- **Sales** = conversions on offer campaigns.
- Keep raw counts for diagnostics, but **clean** is the surfaced/headline number.
- Visits and redirects are a **subset relationship**, never summed: every redirect is also a visit. Total arrivals = visit count.

## Verification

- Run the poll. For a stage that has both a visit row (`gk-lp-visits`) and an offer row with the same `sub_id_3`, confirm the stored row holds visits and redirects as **separate, non-merged** numbers.
- Visit-only stage (landed, nobody clicked through) → redirects = 0, visits > 0.
- Bot-flagged visit clicks **excluded** from clean counts.
- Re-run → updates in place (idempotent), no duplicates.

## Constraints

- CamMan conventions: Supabase transaction pooler (6543, `?prepare=false`), `America/New_York`, Drizzle, idempotent upsert.
- Migration 0062 writes to shared prod Supabase — apply deliberately, do NOT auto-run (`npm run db:migrate` → `verify-migration-integrity.ts`).
- Don't break the existing aggregate behavior for stages that only have offer-redirect data (pre-visit-tracking history).
