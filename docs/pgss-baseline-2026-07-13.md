# pg_stat_statements — frozen baseline (2026-07-13)

**Captured:** 2026-07-13 20:49 UTC, on merged `main`, immediately after the W1 deploy (PR #3) and **immediately before** a `pg_stat_statements_reset()`.

**Why this file exists:** the frozen "before" for the W1-after comparison (propagate INSERT) **and** the starting target list for W2. Because it's a *cumulative* snapshot, the propagate INSERT still shows its old all-time behaviour here (the watermarked query had not yet run at capture time — first watermarked pass fires on the 21:03 `score-pending` tick). The reset right after this capture gives a clean window to measure the watermarked query over the next 24h.

**Stats window:** counters accumulated since **2026-05-11 05:52 UTC** (≈63 days), **12.70 h** total exec time across **4,862** distinct statements. Percentages below are share of that 12.70 h.

> Note: `pg_stat_statements` was **reset at capture time**, so a live query now shows post-reset counters — this file is the only record of the pre-reset cumulative state.

## Top 30 by total execution time

| # | calls | mean ms | total ms | % of DB time | rows | query (truncated) |
|--:|------:|--------:|---------:|-------------:|-----:|-------------------|
| 1 | 1,729 | **8,004.5** | 13,839,744 | **30.29%** | 15,218 | `INSERT INTO clickers … SELECT DISTINCT ON …` — **W1 Task 1c target (propagate-clickers)** |
| 2 | 1,108 | 1,705.8 | 1,890,057 | 4.14% | 1,108 | `select count(*) … from campaign_audience_pool p join contacts … row_number()` — audience count |
| 3 | 733 | 1,733.2 | 1,270,420 | 2.78% | 723 | `SELECT data, downloaded_at … fresh …` — **geoip_cache blob (per cold start)** |
| 4 | 382 | 3,290.7 | 1,257,029 | 2.75% | 14,697 | `select creatives.* …` — creatives list (page / stage picker) |
| 5 | 9,041 | 128.5 | 1,161,443 | 2.54% | 452,050 | `UPDATE stage_sends … SET status … FROM (VALUES …)` — send drain writes |
| 6 | 9,472 | 119.8 | 1,134,881 | 2.48% | 9,472 | `UPDATE campaign_stages … total_cost = CASE …` — cost recompute |
| 7 | 231 | 4,208.2 | 972,097 | 2.13% | 231 | `select count(*) … MAX(tier) … clean click tier` — live lane/tier count |
| 8 | 21 | **26,939.4** | 565,728 | 1.24% | 615 | `refresh materialized view concurrently offer_group_report_mv` — cron |
| 9 | 166 | 3,182.4 | 528,284 | 1.16% | 166 | `select count(*) from stage_sends where status=… and sent_at ∈ [range]` — throughput |
| 10 | 189 | 2,722.9 | 514,628 | 1.13% | 189 | `select count(*) … MAX(tier) … clean click tier` — live tier count (variant) |
| 11 | 15,580 | 30.1 | 469,455 | 1.03% | 735,538 | `UPDATE stage_sends SET status … FOR UPDATE SKIP LOCKED` — drain claim |
| 12 | 14,334 | 30.8 | 441,346 | 0.97% | 716,700 | `INSERT INTO send_attempts …` — send writes |
| 13 | 31 | **13,339.8** | 413,534 | 0.90% | 31 | `with unionized … segment_contacts … contact_contact_groups` — segment eval |
| 14 | 261 | 1,583.1 | 413,185 | 0.90% | 8,299 | `select creatives.* …` — creatives list (variant) |
| 15 | 17 | **23,633.3** | 401,766 | 0.88% | 752,707 | `UPDATE contacts SET carrier_norm … FOR UPDATE SKIP LOCKED` — Telnyx full-table backfill |
| 16 | 83 | 4,665.8 | 387,264 | 0.85% | 83 | `with unionized … segment_contacts …` — segment eval (variant) |
| 17 | 122 | 3,128.6 | 381,692 | 0.84% | 97,388 | `insert into segment_contacts …` — segment membership bulk insert |
| 18 | 4,004 | 95.2 | 381,127 | 0.83% | 4,004 | `UPDATE campaign_stages … total_cost = CASE … EXISTS(stage_sends) …` — cost recompute (variant) |
| 19 | 1,759 | 210.8 | 370,874 | 0.81% | 2 | `SELECT s.id … FROM campaign_stages … WHERE link_mode … send_approved …` — scheduler stage scan |
| 20 | 31,778 | 11.6 | 369,451 | 0.81% | 31,778 | `SELECT count(*) FROM stage_sends WHERE org_id=… AND sent_at > now()-…` — rate-limit check (very frequent) |
| 21 | 2,786 | 122.3 | 340,826 | 0.75% | 136,514 | `UPDATE stage_sends … SET status … FROM (VALUES …)` — send drain writes (variant) |
| 22 | 277,512 | 1.2 | 340,262 | 0.74% | 277,512 | `INSERT INTO clicks …` — click redirect logging |
| 23 | 680 | 490.4 | 333,446 | 0.73% | 680 | `select count(*) from contacts where org_id=… and is_archived=…` — contacts count |
| 24 | 138 | 2,383.4 | 328,911 | 0.72% | 276,000 | `INSERT INTO links …` — per-recipient link minting |
| 25 | 58 | 5,467.3 | 317,101 | 0.69% | 58 | `with unionized … contact_contact_groups …` — group audience eval |
| 26 | 277,036 | 1.1 | 296,583 | 0.65% | 276,979 | `SELECT l.id … FROM links l JOIN link_destinations … WHERE l.code=…` — redirect resolve |
| 27 | 4 | **70,053.2** | 280,213 | 0.61% | 4 | `with unionized … segment_contacts …` — segment eval (worst single-run) |
| 28 | 1,188,825 | 0.2 | 279,225 | 0.61% | 1,188,825 | `insert into keitaro_stage_results …` — Keitaro upsert |
| 29 | 3,222 | 78.8 | 253,866 | 0.56% | 3,222 | `with joined as (select p.contact_id … was_clicker_at_snapshot … exists(opt_outs) …)` — snapshot flags |
| 30 | 76 | 3,230.9 | 245,551 | 0.54% | 76 | `with q as (… campaign_audience_pool … not exists(opt_outs) …)` — audience preview |

## W1-after checkpoints (measured against the fresh window after reset)
- **#1 propagate INSERT** — baseline **8,004.5 ms mean / 30.29%**. Target after watermark + indexes: low double-digit ms mean, small fraction of DB time.
- Watch that **no other statement** regresses into the top offenders after reset.

## W2 candidate targets already visible here (not addressed by W1)
- Live audience/tier counts over `campaign_audience_pool` (#2, #7, #10, #30) — 1.7–4.2 s.
- **geoip_cache 8 MB blob** read per cold start (#3) — 1.7 s.
- **Segment `unionized` eval** (#13, #16, #25, #27) — 4.7 s to **70 s** worst-run.
- Creatives list (#4, #14) — 3.3 s, returns ~14.7 k rows.
- matview refresh (#8) — 26.9 s mean and climbing.
- Telnyx `carrier_norm` full-table UPDATE (#15) — 23.6 s (overlaps the parked `feat/carrier-normalization` work).
- Contacts live counts (#23) and per-batch rate-limit count (#20, 31.8 k calls).

_Frozen record — do not edit. Post-reset comparisons live in the W1-after summary._
