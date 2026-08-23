# Drip Campaigns — Phase 4 Recon: campaigns + routing (zero sends)

_Card: `869endku0` (Drip P4) · parent `869ency4b` · 2026-08-23 · **RECON ONLY — no code, no migrations**_

Scope: `campaigns.type`, drip campaign config, runtime flags (G9), the routing worker,
`drip_journeys`, caps, the "why not routed" debugging tool, and the **R14 exit gate**.

---

## 0. Method

| | |
|---|---|
| Code | `origin/main` @ `f3dc548` (Phase 3 merged and live) |
| Database | production `rtdarhkkjwcetlmruftl` |
| Corpus | campaigns **295** (254 completed / 19 active / 17 archived / 5 paused) · `campaign_audience_pool` **1,567,305 rows / 238 MB** across 291 campaigns · active in-use set **89,339 contacts** · contacts **815,426** · opt_outs **148,127** · `lead_events` **0** · `contact_attributes` **0** |
| Already present | `campaigns.type` **no** · `drip_journeys` **no** · `drip_campaign_configs` **no** |
| Writes | none (`EXPLAIN` without `ANALYZE` executes nothing) |

---

## 1. R14 — the exit gate, measured now rather than at the end

**The in-use set is built in exactly ONE place** in the activation path: the `iu_set` CTE in
`flagSetCtes` ([lib/audience-snapshot.ts:135](../../../lib/audience-snapshot.ts)). Its five consumers
(lines 159, 392, 621, 848, 1178, 1510) all read that one CTE. The other `campaign_audience_pool`
references are per-campaign **materialization** reads, not the in-use exclusion. So R14's blast
radius is far smaller than the risk register feared — one CTE, not a file-wide rewrite.

**Baseline plan, captured from production:**

```
HashAggregate  (cost=9959.01..10720.87 rows=76186 width=16)
  Group Key: p.contact_id
  ->  Nested Loop  (cost=0.57..9768.54 rows=76186 width=16)
        ->  Index Scan using campaigns_status_idx on campaigns ca  (cost=0.15..9.27 rows=14)
        ->  Index Scan using campaign_audience_pool_pkey on campaign_audience_pool p  (cost=0.43..641.51 rows=5558)
```

**With an always-present but empty drip branch UNION'd in:**

```
HashAggregate  (cost=11292.28..12054.15 rows=76187 width=16)     ← +13% total cost
  ->  Append  (cost=9959.01..11101.81 rows=76187)
        ->  HashAggregate  (cost=9959.01..10720.87 rows=76186)   ← the ORIGINAL subplan, unchanged
              ->  Nested Loop  (cost=0.57..9768.54 rows=76186)   ← byte-identical
        ->  Result  (cost=0.00..0.01 rows=1)  One-Time Filter: false
```

The original subplan survives **exactly**, and the empty branch costs 0.01 and is short-circuited.
But the outer `UNION` adds a **second dedup pass**: 9,959 → 11,292, about **+13%**.

**⚠️ R14 says the plan must be byte-identical, not close.** So do not always-emit an empty branch.
**Recommendation (D3): emit the drip branch CONDITIONALLY**, only when the org's drip posture is on.
With drip off, `flagSetCtes` produces character-for-character today's SQL, so the plan is identical
by construction rather than by measurement — which is a much stronger guarantee than a 13% delta
someone has to keep re-justifying.

**⚠️ And G2 touches TWO files, not one.** There is a second, independent in-use definition:
`applyInUseExclusion` in [lib/segment-rules-eval.ts:546](../../../lib/segment-rules-eval.ts), backing
the **per-segment** `exclude_in_use_contacts` flag. It builds its own `EXCEPT` against
`campaign_audience_pool`. If only `audience-snapshot.ts` learns about drip journeys, the two
definitions of "in use" disagree — the campaign-level flag would see drip, the segment-level flag
would not. Both must change, or neither.

---

## 2. Campaign type and config — what the shape should be

### `campaigns.type` is safe to add, with one exception that is NOT safe

`campaigns` has no `type` column (verified). The list endpoint selects columns **explicitly**, so a
new column cannot leak into responses.

**⚠️ But `POST /api/campaigns/[campaignId]/duplicate` builds its insert as an explicit
field-by-field `.values({...})` literal.** Adding `type` without touching that route means
**duplicating a drip campaign silently produces a `regular` one** — it takes the column default. This
is the same failure mode as the providers-page PATCH literal that dropped every field it did not
list: a 200, a success toast, and the wrong data. The duplicate route must carry `type` and the drip
config explicitly, and that must be asserted.

### D1 — drip config belongs in a SEPARATE 1:1 table

The brief lists ~12 drip-only fields. Two options:

| | columns on `campaigns` | 1:1 `drip_campaign_configs` |
|---|---|---|
| Disturbance to "prove regular unaffected" | 13 new nullable columns on the table every regular query touches | **one** column (`type`) |
| Bare `.select()` blast radius | 13 fields into duplicate/split/revert routes | 1 |
| Reads like the codebase | — | mirrors `contact_attributes` (1:1, PK = parent id), decided the same way in 1c |

**Recommendation: separate table.** `campaigns` gains exactly `type`, which makes the "regular
campaigns are unaffected" claim small enough to actually prove.

### D2 — do NOT reuse `start_date` / `end_date`

They are `date`, not `timestamptz`, and **287 of 295 campaigns already set them** as advisory
metadata. The brief needs a hard `received_at ∈ [start_at, end_at)` boundary, which a DATE cannot
express (no "start at 09:00"), and repurposing them would change the meaning of 287 existing rows.
New `start_at` / `end_at` `timestamptz` on the drip config table.

---

## 3. Runtime flags (G9) — the precedent already exists

`org_settings` carries `sends_enabled` (posture) + `sends_paused` (latch), each with
`_updated_by` / `_updated_at`, plus an audit table. Live values: `sends_enabled=true`,
`sends_paused=false`.

Drip mirrors it exactly, keeping the three questions separate:

| Flag | Question | Proposed |
|---|---|---|
| capability | is drip built at all? | `ENTITY_AVAILABILITY` (compile-time) — unchanged |
| **posture** | is drip switched on for this org? | `org_settings.drip_enabled` (default **false**) |
| **latch** | did something trip? | `org_settings.drip_paused` (default false) + reason/at/by |

Merging posture into the latch makes a breaker trip and a human decision indistinguishable — the
lesson already written into the provider-connections work.

**Everything in this phase gates on posture**, including the conditional `iu_set` branch (D3).

---

## 4. Two scope problems worth surfacing before building

### D7 — "same offer + same creative" cannot be fully evaluated in Phase 4

The skip rule is defined against "the campaign's current first-send creatives". **Drip stages do not
exist until Phase 5** — that is the P5 card's scope. So in P4 the creative half of the rule has no
operand.

**Recommendation:** implement the **offer half** now (skip when the contact already has an
`offer_exposures` row for the campaign's offer), record the creative half in the journey `reason`
JSONB as `creative_check: "deferred_p5"`, and wire it when drip stages land. Building a
half-evaluated rule that silently passes everything would be worse — it would look implemented.

### D5 — caps: which window is authoritative, and when

`daily_cap` in the original spec means **sends** ("resets midnight ET, Telegram at ≥90%"). In P4
there are no sends, so counting journeys is a proxy — and not an equivalent one: a journey routed at
23:50 ET sends the next day, so today's journeys ≠ today's sends. Enforcing a send cap against
journeys now, and again against sends in P5, gives two caps fighting over one number.

**Recommendation:**

- **`campaign_cap` (lifetime) is enforced at ROUTING and stays there.** A journey is the commitment;
  this is the natural place for it.
- **`daily_cap` is enforced at SEND time in Phase 5.** In P4 it is stored and displayed but
  **inert**, plus routing applies a same-valued **admission throttle** recorded distinctly in the
  reason as `admission_throttle` — so an operator can always tell "not routed because the day's
  admission was full" from "not sent because the day's send cap was full".

Confirm, because the alternative (enforce both at routing) is defensible too and only differs once
P5 lands.

---

## 5. Migration proposal — **STOPPING HERE FOR APPROVAL**

Next number is **0159**.

### 0159 — `campaigns.type`

```sql
ALTER TABLE campaigns ADD COLUMN type text NOT NULL DEFAULT 'regular';
ALTER TABLE campaigns ADD CONSTRAINT campaigns_type_check CHECK (type IN ('regular','drip'));
CREATE INDEX campaigns_org_type_status_idx ON campaigns (org_id, type, status);
```

`NOT NULL DEFAULT 'regular'` so all 295 existing rows are correct without a backfill, and so a
missing/unknown type can never be read as drip — the same fail-toward-existing-behaviour direction
R13 mandates for the breaker.

### 0160 — `drip_campaign_configs` (1:1 with a drip campaign)

```
campaign_id     integer PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE
org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
interest_tag    text NOT NULL                      -- required; the routing dimension
partner_key_id  integer REFERENCES partner_keys(id) ON DELETE SET NULL   -- optional filter
start_at        timestamptz
end_at          timestamptz
daily_cap       integer                            -- CHECK > 0; inert in P4 (D5)
campaign_cap    integer                            -- CHECK > 0; enforced at routing
priority        integer NOT NULL DEFAULT 100       -- lower wins
filters         jsonb NOT NULL DEFAULT '{}'        -- gender/age_band/state/country/income_band/kids/married
created_at      timestamptz NOT NULL DEFAULT now()
updated_at      timestamptz NOT NULL DEFAULT now()

CHECK (end_at IS NULL OR start_at IS NULL OR end_at > start_at)
INDEX (org_id, interest_tag)
RLS: ENABLE + SELECT-only org policy
```

Carrier filter is **not** duplicated here — drip reuses `campaigns.audience_filters.carrier_filter`,
which 185 of 295 campaigns already use.

**Demographic filters live in one JSONB, not seven columns**, because the rule is uniform
(skip-if-missing) and the set is explicitly extensible; seven nullable columns would need a migration
per new filter. Validated in Zod against the `contact_attributes` field list, the same way segment
rule values are.

### 0161 — `drip_journeys`

```
id             uuid PK DEFAULT gen_random_uuid()
org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE
campaign_id    integer NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE
contact_id     uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE
lead_event_id  uuid NOT NULL REFERENCES lead_events(id) ON DELETE CASCADE
state          text NOT NULL DEFAULT 'routed'
               -- CHECK IN ('routed','active','completed','exited','unroutable')
routed_at      timestamptz NOT NULL DEFAULT now()
reason         jsonb NOT NULL DEFAULT '{}'
created_at     timestamptz NOT NULL DEFAULT now()

UNIQUE (lead_event_id)                                   -- idempotent re-route
UNIQUE (org_id, contact_id) WHERE state IN ('routed','active')   -- ⭐ ONE CAMPAIGN ONLY
INDEX (org_id, campaign_id, state)                       -- cap counting
INDEX (org_id, state, routed_at)                         -- the worker's scan
RLS: ENABLE + SELECT-only org policy
```

**⭐ The partial UNIQUE on `(org_id, contact_id)` is what makes "exactly ONE campaign" a database
guarantee rather than a property of the routing code.** A race between two worker ticks, or a future
second caller, cannot produce two live journeys for one contact — the index refuses. Everything else
in the routing rules is policy; this is an invariant.

`UNIQUE (lead_event_id)` makes re-routing the same arrival a no-op, the same crash-safety trick
`lead_events.inbox_id` uses.

### 0162 — `org_settings` drip flags (G9)

```sql
ALTER TABLE org_settings ADD COLUMN drip_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE org_settings ADD COLUMN drip_enabled_updated_by uuid;
ALTER TABLE org_settings ADD COLUMN drip_enabled_updated_at timestamptz;
ALTER TABLE org_settings ADD COLUMN drip_paused boolean NOT NULL DEFAULT false;
ALTER TABLE org_settings ADD COLUMN drip_paused_reason text;
ALTER TABLE org_settings ADD COLUMN drip_paused_at timestamptz;
ALTER TABLE org_settings ADD COLUMN drip_paused_by uuid;
```

Mirrors the `sends_enabled` / `sends_paused` shape exactly, audit columns included.

---

## 6. Decisions needed (D1–D7)

| # | Decision | Recommendation |
|---|---|---|
| **D1** | drip config: columns on `campaigns` vs 1:1 table | **1:1 table.** `campaigns` gains only `type`, keeping "regular is unaffected" small enough to prove |
| **D2** | reuse `start_date`/`end_date`? | **No.** `date` cannot express a hard boundary, and 287/295 rows already use them as advisory metadata |
| **D3** | R14: always-UNION an empty branch, or emit conditionally? | **Conditionally, gated on drip posture.** Always-UNION measurably costs +13%; conditional is byte-identical *by construction* |
| **D4** | G2 in one file or two? | **Two.** `iu_set` and `applyInUseExclusion` are independent definitions; changing one makes them disagree |
| **D5** | caps: routing vs send time | `campaign_cap` at routing; `daily_cap` **inert in P4**, authoritative at send time in P5, with a distinctly-named routing admission throttle |
| **D6** | TTL for unrouted leads | **7 days**, chosen to coincide with the >1-week re-entry rule so an `unroutable` lead becomes re-eligible exactly when the week rule would re-qualify it anyway — not an arbitrary number |
| **D7** | same-offer-same-creative in P4 | **Offer half only.** Drip stages are P5, so the creative half has no operand; record `creative_check: "deferred_p5"` in the reason rather than shipping a rule that silently passes everything |

---

## 7. Risk register additions

| # | Risk | Mitigation |
|---|---|---|
| **R25** | The duplicate route drops `type`, silently turning a duplicated drip campaign regular | Explicit carry + an assertion. Same class as the providers PATCH literal |
| **R26** | The two in-use definitions drift (D4) | Change both in one PR; assert they return the same set for the same input |
| **R27** | `daily_cap` enforced twice once P5 lands (D5) | Name the two windows differently in code, reason JSONB and UI from the start |
| **R28** | Routing input is **0 rows today** (`lead_events` = 0, `contact_attributes` = 0), so every routing rule is unexercised by real data | The production proof must synthesize every case — and each filter needs a control proving it *rejects* as well as admits |

---

## 8. What I have NOT done

No code, no migrations, no branch. Two read-only probes (deleted). Awaiting rulings on **D1–D7** and
approval of **0159–0162**.
