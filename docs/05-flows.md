# 05 — End-to-end Flows

_Last updated: 2026-08-13_

Sequence diagrams for the core journeys. File references point at the authoritative code.

## A. Signup → org bootstrap
See [04-features/multi-tenancy-auth.md](04-features/multi-tenancy-auth.md).

```mermaid
sequenceDiagram
  participant U as User
  participant App
  participant SB as Supabase Auth
  participant DB as Postgres
  U->>App: sign up (email, pw, display_name)
  App->>SB: auth.signUp(emailRedirectTo=/auth/callback)
  SB->>DB: INSERT auth.users → trigger handle_new_user()
  DB->>DB: create organizations + org_members(owner)
  SB-->>U: verification email
  U->>App: click link → /auth/callback (exchangeCodeForSession)
  App-->>U: /dashboard (layout requireOrgMembership)
```

## B. Campaign creation → activation (manual mode)

```mermaid
sequenceDiagram
  participant Op as Operator
  participant Ed as Campaign editor
  participant API
  participant Snap as snapshotAudience()
  participant DB
  Op->>Ed: create draft (name, brand, offer, segments+groups, filters, cap)
  Ed->>API: POST /api/campaigns (draft, may be empty)
  API->>DB: INSERT campaigns (+tracking_id if brand+offer set)
  Op->>Ed: add stages (creative, provider, phone, short_url, stop_text, schedule)
  Ed->>API: POST stages (+stage tracking_id if ready)
  Op->>Ed: preview audience
  Ed->>API: POST /api/campaigns/audience-preview → counts
  Op->>API: set status=active
  API->>API: gate name+brand+offer+≥1 contact group
  API->>Snap: BEGIN tx · snapshot → INSERT campaign_audience_pool
  alt empty
    API->>DB: ROLLBACK → 400
  else
    API->>DB: UPDATE status=active, freeze count · COMMIT
  end
```

## C. Manual send → results import

```mermaid
sequenceDiagram
  participant Op as Operator
  participant App
  participant Prov as External provider tool
  participant Imp as import route (tx)
  participant DB
  Op->>App: export audience CSV (stage)
  App-->>Op: CSV (phones from frozen pool, live opt-out excluded)
  Op->>Prov: upload + send SMS manually
  Prov-->>Op: results CSV (delivered/failed/optout/clicker/...)
  Op->>App: import CSV (FileDropZone + provider mapping)
  App->>Imp: POST import-preview → sample
  Op->>Imp: POST import
  Imp->>DB: upsert contacts; derive outcomes; propagate opt_outs/clickers; write stage_result_rows; update counters
  Imp-->>Op: summary; revertible from history
```

## D. Tracked send (TextHub) → click attribution

```mermaid
sequenceDiagram
  participant Op as Operator (drain perm)
  participant Kick as kickoffStageSend
  participant Mint as mintLink
  participant Drain as runStageDrain
  participant TH as TextHub
  participant Rec as Recipient
  participant R as /r/[code]
  participant Score as score-pending cron
  Op->>Kick: kickoff stage (tracked, send_approved)
  Kick->>Mint: per recipient → links + link_destinations
  Kick->>Kick: INSERT stage_sends (rendered_text frozen, send_token=id)
  Op->>Drain: drain (SEND_ENABLED + approved + !paused + breakers)
  Drain->>Drain: resolve key: stage.provider_phone_id -> provider_phones.credential_id -> provider_credentials
  Drain->>Drain: decryptCredentialKey (api_key_encrypted else legacy plaintext api_key)
  loop batch
    Drain->>TH: GET send(api_key,text,number)
    TH-->>Drain: {ok,messageId,status}
    Drain->>Drain: mark sent / filtered (status="Suppressed") / failed; ceilings + spike checks
  end
  Rec->>R: GET /r/<code>
  R->>R: first-pass classify (UA/headers)
  R->>R: INSERT clicks; append &sub_id1=<send_token>; 302 → destination
  Score->>Score: */15 enrich (MaxMind ASN) + bot_score + classification
```
> The redirect appends `&sub_id1=<send_token>` (= `stage_sends.id`) to the shared destination so a later Keitaro sale attributes back to this recipient (flow H). The operator's stage Full URL is never touched.

> **Key resolution is number → account → key (migration 0110).** A stage with no `provider_phone_id` falls back to the legacy `(provider, brand)`/default lookup, but only while the provider has exactly ONE credential — once a provider has ≥2 accounts a numberless stage refuses (`no_credentials`) rather than guessing. The key is decrypted at this point only (AES-256-GCM `api_key_encrypted`, dual-read against legacy plaintext `api_key`) — never earlier, never returned by any list/GET response. See [07-conventions.md](07-conventions.md).

## E. Opt-out (STOP) intake

```mermaid
sequenceDiagram
  participant Cron as */5 opt-outs/poll
  participant App
  participant TH as TextHub inbox
  participant DB
  Cron->>App: GET /api/opt-outs/poll (Bearer CRON_SECRET)
  App->>TH: GET ?inbox=true per credential
  TH-->>App: inbound messages (STOP, etc.) — phone + body + received_at only
  App->>DB: INSERT opt_outs (source sms_inbound, org-wide) + texthub_inbound_events
  App->>DB: match stage_sends by phone, sent within 72h of received_at
  DB-->>App: every stage that sent to the number in the window
  App->>DB: INSERT opt_out_attributions (1/stage) + bump campaign_stages.inbound_opt_out_count
  Note over App,DB: org-wide opt-out excludes the contact from all future snapshots;<br/>attribution is additive analytics (Reports + campaign "Inbound STOPs"), never a gate
  App->>DB: checkOptOutRateBreaker(ATTRIBUTED STAGE) — 2 queries, 24h + 2h in one FILTER pass
  Note over App,DB: numerator JOINs stage_sends ON id = stage_send_id ⇒ BOTH sides<br/>bucket by sent_at (one aligned send cohort, never STOP receipt time)
  DB-->>App: sent{24h,2h} + aligned opt_outs{24h,2h}
  App->>DB: breach ⇒ UPDATE campaigns SET send_paused (SAME tx) + campaign_circuit_events
  App-->>App: post-commit: Telegram alert (rate, counts, stage, campaign link)
```

**Breaker step (P7/P8, cohort re-cut 2026-07-26).** The rate is judged on the **attributed stage** and the latch applied to its **campaign**. Both counts bucket by `stage_sends.sent_at`, so the metric is "of what this stage sent in the window, what fraction has STOPped so far" — bucketing the numerator by `oa.created_at` makes it unbounded and auto-paused four campaigns on false signals (see [the diagnostic](optout-rate-breaker-false-trip-2026-07-25.md)). A long (24h @ 10%) and a short (2h @ 8%) window are evaluated from the same pair of queries; either can latch. Attributions with a NULL `stage_send_id` are excluded, and the hourly Telegram cron alerts if that share exceeds 5%.

Attribution rule (migration 0075): TextHub's inbox has no campaign reference, so a STOP is credited to **every** stage that sent to the number within a 72h trailing window (`OPT_OUT_ATTRIBUTION_WINDOW_HOURS`). One `opt_out_attributions` row per (opt_out, stage); the per-stage `inbound_opt_out_count` counter drives the Reports "Opt-outs" column, and the campaign page shows DISTINCT attributed contacts. No match ⇒ org-wide opt-out only. See [lib/sends/poll-opt-outs.ts](../lib/sends/poll-opt-outs.ts).

## E2. Ahoi DLR (delivery receipt) capture

```mermaid
sequenceDiagram
  participant Ahoi
  participant App
  participant DB
  Ahoi->>App: POST /api/webhooks/ahoi/dlr/<token> (form-encoded)
  App->>DB: resolve token -> (org, provider, credential)
  Note over App: 207.181.190.0/24 IP check is LOGGED ONLY (G1: token is the gate)
  App->>App: parseDlr (uuid/source/destination/send_status/status/smpp_status/smpp_code/error)
  App->>DB: INSERT ahoi_dlr_events (raw + parsed)
  App->>DB: reconcile uuid -> stage_sends.texthub_message_id (Task 5)
  Note over App,DB: capture + reconcile only — no opt_outs write (Section 4's job)
```

## E3. Ahoi inbound (STOP-carrying) webhook capture

```mermaid
sequenceDiagram
  participant Ahoi
  participant App
  participant DB
  Ahoi->>App: POST /api/webhooks/ahoi/inbound/<token> (form-encoded)
  App->>DB: resolve token -> (org, provider, credential) — same token as the DLR webhook
  App->>App: parseInbound (source/destination/message/type/cost)
  App->>DB: INSERT ahoi_inbound_events (source='webhook')
  App->>App: processAhoiInboundOptOut (Section 4): keyword match, dedup vs CDR (CARRY 1), contact upsert, opt_outs write
  Note over App,DB: capture ALWAYS commits + always 200-acks Ahoi; a process failure fires a LOUD Telegram alert (never silent) and the CDR poll (Layer 2, ≤45min) re-runs it
```

## E4. Ahoi CDR poll (every 15 min, inbound backstop)

```mermaid
sequenceDiagram
  participant Cron as ahoi-cdr-poll (13,28,43,58)
  participant App
  participant Ahoi as Ahoi CDR (system of record)
  participant DB
  Cron->>App: GET /api/cron/ahoi-cdr-poll (Bearer CRON_SECRET)
  App->>Ahoi: GET /cdrs/download/csv?startdate=<ET yesterday>&enddate=<ET today>&key=
  Ahoi-->>App: CSV (all directions)
  App->>App: filter direction=in
  App->>DB: INSERT ahoi_inbound_events (source='cdr') ON CONFLICT (provider_id, provider_uuid) DO NOTHING
  App->>App: processAhoiInboundOptOut per NEW row (Section 4), same core as Layer 1 (E3/E5)
  Note over App,DB: idempotent backstop, not because the webhook is lossy —<br/>upstream-carrier loss is unrecoverable by either channel (Phase 0 recon).<br/>Capture+process is ONE transaction per row — a processing failure rolls back the capture too, retried next tick.
```

## E5. Ahoi opt-out intake — 3 layers converge on `opt_outs`

```mermaid
sequenceDiagram
  participant L1 as Layer 1 (E3 webhook)
  participant L2 as Layer 2 (E4 CDR poll)
  participant L3 as Layer 3 (E2 DLR)
  participant App
  participant DB
  L1->>App: parsed STOP, source_number (10-digit)
  L2->>App: parsed STOP, source_number (10-digit)
  L3->>App: rejected DLR, destination (10-digit)
  App->>App: keyword match (L1/L2) or classifyAhoiDlrOptOut (L3, G4 defensive — empty allowlist today)
  App->>App: findDuplicateAhoiInbound (CARRY 1, L1/L2 only) — same physical STOP via both channels?
  App->>App: ahoiSourceToE164 (CARRY 2) — 10-digit -> E.164
  App->>DB: upsert contacts (org_id, phone_number)
  App->>DB: INSERT opt_outs (source: ahoi_inbound_webhook | ahoi_cdr | ahoi_dlr_optout)
  App->>DB: latestSendForAttribution (shared w/ TextHub) -> opt_out_attributions + campaign_stages counters
  Note over App,DB: existing lib/sends/recipients.ts opt_outs NOT-EXISTS check now suppresses these contacts — zero enforcement-side changes
```

Layer 3 ships with an intentionally EMPTY known-opt-out-code allowlist (`AHOI_KNOWN_OPTOUT_DLR_CODES`, `lib/sends/ahoi-dlr-optout.ts`) — no real Ahoi opt-out DLR signature has been observed live (O1). It is fully wired and tested but will not classify anything as an opt-out in production until a human adds a real code after seeing one in the `[ahoi-dlr-optout]` distinct-log lines. See [07-conventions.md](07-conventions.md).

## E6. Text Request delivery status — per-message callback + poll backstop

```mermaid
sequenceDiagram
  participant Drain as Send drain
  participant TR as Text Request
  participant Hook as /api/webhooks/textrequest/status/[token]?ss=
  participant Cron as /api/cron/textrequest-poll (4,19,34,49)
  participant DB
  Drain->>TR: POST /messages {from,to,body,status_callback=…/status/<token>?ss=<stage_send_id>}
  TR-->>Drain: {message_id, status:"sending", segments_count}
  Drain->>DB: stage_sends.texthub_message_id = message_id · send_attempts.segments_count
  TR->>Hook: POST {message_id, status, errorCode}
  Hook->>DB: INSERT textrequest_dlr_events (method='POST')
  Hook->>DB: reconcile — ?ss= DIRECTLY (else message_id -> stage_sends.texthub_message_id)
  Hook->>Hook: errorCode 2100 ⇒ opt-out (E7 signal 4a)
  Hook-->>TR: 200 ALWAYS (a non-2XX counts toward TR's 10-strike hook disconnect)
  Note over Drain,Hook: no inbound_webhook_token or no origin ⇒ NO status_callback is requested at all; the poll is then the only reconciler
  Cron->>TR: GET /dashboards/{id}/messages?start_date&end_date&page&page_size
  TR-->>Cron: {items (oldest→newest), meta{total_items}}
  Cron->>Cron: read page 0 for total_items, then walk pages BACKWARDS (newest first)
  Cron->>DB: INSERT textrequest_dlr_events (method='poll') ON CONFLICT (provider_id,message_id,status) DO NOTHING
```

## E7. Text Request opt-out intake — 4 signals converge on `opt_outs`

```mermaid
sequenceDiagram
  participant S1 as 1. msg_received hook (real-time STOP)
  participant S2 as 2. contact_updated hook (TR's own opt-out flag)
  participant S3 as 3. polls (messages R rows / contacts has_opted_out)
  participant S4 as 4. errorCode 2100 (DLR) / 30050 (send reject)
  participant App as processTextrequestOptOut
  participant DB
  S1->>App: conversation.consumerPhoneNumber + conversation.message (direction 'R' only)
  S2->>App: phone_number + opted_out_utc / is_suppressed
  S3->>App: same facts, polled (backstop for a disconnected hook)
  S4->>App: recipient resolved from the reconciled stage_send (DLR body has no phone)
  App->>App: message-shaped ⇒ isOptOutKeyword gate · state-shaped ⇒ authoritative, acts ONCE per number
  App->>App: capture idempotency: UNIQUE(provider_id, provider_uuid) — webhook + poll share TR's message GUID
  App->>App: findDuplicateTxrInbound (45-min window) — cross-SHAPE duplicates (STOP vs contact flag)
  App->>DB: upsert contacts · INSERT opt_outs (source: textrequest_inbound_webhook | _messages_poll | _contact_webhook | _contacts_poll | _dlr_optout | _send_reject)
  App->>DB: cascade-cancel pending stage_sends -> skipped_opted_out / opt_out_cancel
  App->>DB: latestSendForAttribution -> opt_out_attributions + campaign_stages counters + recomputeStageTotalCost
  App->>DB: checkOptOutRateBreaker (latch in-tx; Telegram post-commit)
```

Unlike Ahoi's Layer 3, Text Request's opt-out error codes are **documented and live from day one** (2100 on a delivery status, 30050 on a send response). A hit means our suppression list is behind Text Request's. An UNMATCHED 2100 DLR carries no recipient (the body is only `{message_id,status,errorCode}`) and is logged rather than guessed at — the contacts poll is the backstop for that number.

## E8. Tells webhook intake — persist-first capture (DLR + inbound)

```mermaid
sequenceDiagram
  participant T as Tells
  participant R as /api/webhooks/tells/{dlr|inbound}/[token]
  participant DB
  participant Sw as /api/cron/tells-sweep (*/5, offset :2)
  T->>R: POST JSON
  R->>R: read body ONCE as text (the evidence)
  R->>DB: resolveTellsCredential(token) scoped to sms_provider_id='tls'
  alt token does not resolve
    R->>R: Tells-shaped body? console.error + Telegram (the event's LAST copy) : silent console.warn
    R-->>T: 401
  end
  opt inbound only (F1 second factor)
    R->>DB: resolveCredentialKeyById -> stored api_key
    R->>R: safeEqual(payload Key, stored key); mismatch ⇒ 401 + alert, nothing persisted
    R->>R: ⚠️ §4.6 redactTellsKeyFromBody — the live API key NEVER reaches raw_body
  end
  R->>R: guarded extraction (~8 fields, try/catch ⇒ NULLs) + dedup_key
  R->>DB: ONE committed INSERT (ON CONFLICT DO UPDATE bumps duplicate_count ONLY)
  alt INSERT fails
    R->>R: console.error + Telegram with the payload (last copy)
    R-->>T: 500 — never ack what was not stored
  end
  R->>DB: best-effort inline processing (reconcile / suppress) — cannot fail the request
  R-->>T: 200
  Note over DB,Sw: processed_at IS NULL is the work queue
  Sw->>DB: drain oldest-first, ≤200/tick, ≤10 attempts, then alert on stuck rows
```

The inline attempt is free precisely because the row is already committed: even if processing blows past Tells's 12-second timeout, the event is ours and we never needed their ack. **Tells has no poll and no reconciliation API**, so this sweeper is the only recovery path — which is why neither Ahoi nor Text Request has an equivalent.

## E9. Tells opt-out intake — ONE signal, and it is the only automated STOP path

```mermaid
sequenceDiagram
  participant T as Tells inbound webhook (the ONLY channel)
  participant App as processTellsOptOut
  participant DB
  T->>App: From (contact) + Body, from the committed event row
  App->>App: isOptOutKeyword(Body) — the SHARED gate (first token, uppercased, non-letters stripped)
  Note over App: no match ⇒ result='ignored', stored forever, nothing downstream reads it
  App->>App: tellsPhoneToE164(From) — null ⇒ 'invalid_phone', never a guessed number
  App->>App: findDuplicateTellsInbound (45-min window, same number + same text)
  App->>DB: upsert contacts (a STOP must stick for a non-contact number)
  App->>DB: INSERT opt_outs (source 'tells_inbound_webhook', created_at = ORIGINAL receipt time)
  App->>DB: cascade-cancel pending stage_sends -> skipped_opted_out / opt_out_cancel
  App->>DB: latestSendForAttribution -> opt_out_attributions + stage counters + recomputeStageTotalCost
  App->>DB: checkOptOutRateBreaker (latch in-tx; Telegram post-commit)
  App->>DB: stamp result='suppressed' + processed_at
```

**Suppression is org-wide and unconditional; attribution is best-effort.** If `latestSendForAttribution` returns null the contact is still suppressed — the opt-out simply isn't credited to a stage. Losing attribution is a reporting gap; losing suppression would be a compliance breach, and the two are deliberately not coupled.

Unlike Text Request's four signals, Tells has exactly **one**: no state-shaped "contact is opted out" flag, no poll, no opt-out error code on a DLR. Combined with STOP-undelivered self-healing being closed as won't-build (spec §8), **this webhook is the entire automated STOP surface** — which is what makes the Phase 4 silence monitors compliance infrastructure rather than observability polish.

## F. Segment rule audience resolution
See [04-features/audience-segments.md](04-features/audience-segments.md) — `buildSegmentAudienceClause` compiles rules to UNION/INTERSECT/EXCEPT set arithmetic and UNIONs the result with manual membership.

## G. Keitaro results poll (every 5 min)

```mermaid
sequenceDiagram
  participant Cron as */5 keitaro/poll
  participant Poll as pollKeitaro
  participant K as Keitaro Admin API
  participant DB
  participant CRM as /api/keitaro/results
  Cron->>Poll: GET /api/keitaro/poll (Bearer CRON_SECRET)
  Poll->>K: POST /report/build (3-day ET window, group day+sub_id_3)
  K-->>Poll: rows[{day, sub_id_3, clicks, leads, sales, revenue, epc…}]
  Poll->>DB: resolve sub_id_3 → campaign_stages.tracking_id (stage/campaign/org)
  loop each matched row
    Poll->>DB: UPSERT keitaro_stage_results (org_id, stage_id, stat_date)
  end
  Note over Poll,DB: idempotent (last-write-wins) — re-poll overwrites, never double-counts;<br/>unmatched/blank sub_id_3 counted + sampled, not written
  CRM->>DB: GET results?campaign_id → per-stage + campaign rollup (derived rates)
```

> `sub_id_3` carries the **stage** tracking id, so rows are per-stage; campaign totals = SUM across stages. Per-recipient SALE detail is a **separate** poll keyed on `sub_id_1` (flow H).

## H. Keitaro conversions poll → per-recipient sale (every 15 min)

```mermaid
sequenceDiagram
  participant Cron as */15 keitaro/poll-conversions
  participant Poll as pollKeitaroConversions
  participant K as Keitaro Admin API
  participant DB
  Cron->>Poll: GET /api/keitaro/poll-conversions (Bearer CRON_SECRET)
  Poll->>K: POST /conversions/log (7-day ET window, columns incl. sub_id_1, event_id, revenue)
  K-->>Poll: rows[{event_id, sub_id_1, status, revenue, datetime…}]
  Poll->>Poll: fold latest conversion per sub_id_1 (in-memory, by datetime)
  Poll->>DB: SELECT stage_sends WHERE id IN (sub_id_1…) — resolve matched + current event_id
  loop each matched recipient (event_id changed)
    Poll->>DB: UPDATE stage_sends SET sale_status, sale_revenue, converted_at, keitaro_conversion_id
  end
  Note over Poll,DB: dedup on event_id (skip unchanged) + latest-wins ⇒ idempotent;<br/>blank/non-UUID sub_id_1 counted unmatched (clicks predating the sub_id1 rollout)
```

> `sub_id_1` = the recipient's `stage_sends.id` (injected at redirect time, flow D). One sale per recipient, **latest wins** (not cumulative). The **Sale** badge on the Activity → Messages list reads `sale_status`/`sale_revenue`. See [04-features/keitaro-poll.md](04-features/keitaro-poll.md) §8.

## I. Keitaro offer-reach poll → per-recipient offer-page reach (every 15 min, engagement Level 2)

```mermaid
sequenceDiagram
  participant Cron as */15 keitaro/poll-offer-reaches
  participant Poll as pollKeitaroOfferReaches
  participant K as Keitaro Admin API
  participant DB
  Cron->>Poll: GET /api/keitaro/poll-offer-reaches (Bearer CRON_SECRET)
  Poll->>K: POST /clicks/log (7-day ET window, sub_id_1 NOT_EQUAL "", columns incl. event_id, campaign)
  K-->>Poll: rows[{event_id, sub_id_1, campaign, campaign_id, datetime}]
  Poll->>Poll: drop campaign="gk-lp-visits" (landing/L1); fold earliest offer click per sub_id_1
  Poll->>DB: SELECT stage_sends WHERE id IN (sub_id_1…) — resolve matched + current offer_reach_event_id
  loop each matched recipient (not yet reached)
    Poll->>DB: UPDATE stage_sends SET offer_reached_at, offer_reach_event_id WHERE offer_reached_at IS NULL
  end
  Note over Poll,DB: reach is monotonic — already-stamped rows skipped (dedup on event_id);<br/>landing (gk-lp-visits) clicks are Level 1, never stamped here
```

> Same id chain as sales (`sub_id_1` = `stage_sends.id`), but the SOURCE is clicks, classified by campaign name: `gk-lp-visits` ⇒ landing (Level 1, dropped); any other ⇒ offer (Level 2). The `reached_offer*` segment rules read `offer_reached_at`. "Reached but didn't buy" = `reached_offer` is + `made_purchase` is_not. See [04-features/keitaro-poll.md](04-features/keitaro-poll.md) §8b.

## J. Reports rollup maintenance (every 15 min)

```mermaid
sequenceDiagram
  participant Cron as report-rollup (14,29,44,59)
  participant Fn as refreshReportRollup
  participant DB
  Cron->>Fn: GET /api/cron/report-rollup (Bearer CRON_SECRET)
  Fn->>DB: withCronLease("report-rollup") — claim cron_locks row
  Fn->>DB: UPSERT report_stage_hour + report_group_hour<br/>for buckets with SEND hour ≥ now()−14d
  Fn->>DB: settle (freeze) buckets older than now()−14d
  Fn->>DB: stamp cron_locks.watermark = now()
  Note over Fn,DB: bounded rolling-window — recomputes only the unsettled 14d,<br/>idempotent UPSERT re-clobbers as clicks/opt-outs/sales trickle in
```

> Runs just after the opt-out / conversions / offer-reach pollers each quarter-hour so it folds in freshly-attributed engagement. All bucketing is by the SEND hour in ET; sales/revenue use the per-recipient `stage_sends` attribution (not the Keitaro daily aggregate) so they're hour- and group-splittable. Grand totals come from `report_stage_hour`; `report_group_hour` fans out over contact groups and is non-additive. See [04-features/reports-rollup.md](04-features/reports-rollup.md).
