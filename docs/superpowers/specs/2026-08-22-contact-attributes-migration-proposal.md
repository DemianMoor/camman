# 1c — `contact_attributes` migration proposal

_Parent: [869ency4b](https://app.clickup.com/t/869ency4b) · P1 card: [869endkj6](https://app.clickup.com/t/869endkj6) · Date: 2026-08-22 · Status: **proposal — awaiting approval, nothing built**_

Read against `origin/main` @ `14e00bb` and the live production database, 2026-08-22.
**No migration written, no branch, no code.**

Approved shape from the 1c ruling: build `/contacts/[id]`; copy `results-import-form.tsx`'s
mapping UI with saved templates; register the rule types in all **five** places including the SQL
emitter; under-18 enforced in SQL with NULL `dob` ≠ adult. This document covers only the first
gate — **the migration** — as instructed.

---

## ⚠️ Read this first: "NULL dob ≠ adult" is correct *inside an age rule* and catastrophic *globally*

The ruling is right, and the scope it applies at decides whether the feature works at all.

Measured today: **815,426 contacts, 769,272 currently eligible, and `contact_attributes` does not
exist — so exactly 0 contacts have a `dob`.**

If "NULL dob is not an adult" were applied as a **global send-eligibility filter**, it would
exclude **100% of the audience** — every campaign would resolve to zero recipients the moment the
migration landed. That is not a hypothetical: attributes only ever get populated for drip leads
and for contacts touched by the new CSV mapping, so the NULL-dob population stays close to the
whole base for a long time.

**Proposed scope — three distinct things, deliberately not merged:**

| | rule | applies to |
|---|---|---|
| **A** | An `age_band` rule matches only contacts whose `dob` is known **and** falls in the band. NULL `dob` matches **nothing** — you cannot demonstrate the band. | the `age_band` rule only |
| **B** | No `age_band` rule can ever select someone under 18. A hard floor in the emitted SQL, independent of which band was chosen. | the `age_band` rule only |
| **C** | A global "never message a minor" gate across every send path, regardless of whether an age filter is used. | **NOT in 1c** |

**A and B are in this migration's scope. C is not**, and I am flagging rather than silently
choosing: a true global minor-gate belongs on the send/audience path, needs its own ruling, and is
**currently moot** — with zero known `dob` values there is nobody it could exclude except everybody.
The safe form of C, when it is wanted, is "exclude contacts whose `dob` is known **and** under 18",
which leaves NULL alone. Please confirm C stays out of 1c.

---

## Proposed table

Migration **`0147_contact_attributes.sql`** (journal tail is idx 146).

```sql
CREATE TABLE public.contact_attributes (
  -- 1:1 with contacts. contact_id IS the PK — one attribute row per contact,
  -- enforced structurally rather than by a unique index on a surrogate id.
  contact_id   uuid PRIMARY KEY REFERENCES public.contacts(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  first_name   text,
  last_name    text,
  address      text,
  state        text,
  country      text,
  email        text,
  gender       text,
  income_band  text,
  kids         boolean,
  married      boolean,
  dob          date,
  interest_tag text,
  partner_slug text,
  source       text,

  -- Fields we have not defined yet. Not indexed until a query needs it.
  extra        jsonb NOT NULL DEFAULT '{}'::jsonb,

  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contact_attributes_income_band_check
    CHECK (income_band IS NULL OR income_band IN
      ('lt_25k','25k_50k','50k_75k','75k_100k','100k_150k','gte_150k')),
  CONSTRAINT contact_attributes_gender_check
    CHECK (gender IS NULL OR gender IN ('male','female','other')),
  CONSTRAINT contact_attributes_dob_sane_check
    CHECK (dob IS NULL OR (dob > DATE '1900-01-01' AND dob <= CURRENT_DATE))
);
```

### Column decisions

- **`contact_id` as PK.** The 1:1 is structural — no surrogate `id`, no separate unique index.
  `ON DELETE CASCADE` so deleting a contact takes its attributes with it.
- **`org_id` carried** even though it is reachable through `contacts`. Every RLS policy and every
  app query filters on it directly; joining to `contacts` just to satisfy the policy would put a
  join inside the hot segment-eval path. This matches `stage_sends`, `campaign_audience_pool` and
  every other child table here.
- **`dob date`, not a timestamp, and age NEVER stored.** Derived at query time (below). A stored
  `age` int is wrong the day after it is written.
- **`kids` / `married` as `boolean`** in the column, but exposed to segment rules as a
  **set of `['yes','no']`** so all nine new rule types share one value shape and an operator can
  express "either". A three-state NULL means "unknown", which no band selects.
- **`income_band` as a coded string**, CHECK-constrained to the six bands. It is a closed set and
  it drives a rule — an unconstrained free-text column would let an import write `"50-75k"` and
  silently match nothing. Codes rather than display strings so the labels can be reworded without
  a data migration.
- **`interest_tag` and `partner_slug` deliberately NOT constrained.** The spec calls interest tags
  explicitly extensible (ACA / Medicare / Home_Services are only the initial set) and partner slugs
  are created per partner in Phase 2. Validated in Zod at the write boundary instead, so adding a
  tag is a config change rather than a migration.
- **`gender` CHECK'd to three values.** Small closed set; same reasoning as income.
- **`source`** free text — which pipeline wrote the row (`drip_intake`, `csv_upload`, …).
- **`updated_at`** with `now()` default. No `created_at`: the contact's own `created_at` already
  answers "when did we first see this person", and a second, subtly different creation timestamp
  invites the two to be confused in reporting.
- **`dob` sanity CHECK** rejects the classic import artefacts (year 0001, epoch 1970-01-01 as a
  "missing" marker is *not* caught — see the open question below — and future dates).

### RLS

```sql
ALTER TABLE public.contact_attributes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "contact_attributes_select_own_org"
  ON public.contact_attributes FOR SELECT
  USING (org_id = public.current_org_id());
```

SELECT-only, no write policies — the 0085 / 0146 shape. Every writer is the server's privileged
Drizzle connection (`DATABASE_URL`), which bypasses RLS, as does `service_role`; an absent write
policy is a denial, so anon/authenticated lose INSERT/UPDATE/DELETE/TRUNCATE. This is a **tenant**
table (it has `org_id`), so it gets a policy rather than shipping policy-less like the org-less
infra tables.

Post-apply: run the security advisor and confirm `rls_disabled_in_public` ERRORs stay at **0**.

### Indexes — deliberately minimal

```sql
CREATE INDEX contact_attributes_org_idx           ON public.contact_attributes (org_id);
CREATE INDEX contact_attributes_org_interest_idx  ON public.contact_attributes (org_id, interest_tag);
CREATE INDEX contact_attributes_org_partner_idx   ON public.contact_attributes (org_id, partner_slug);
CREATE INDEX contact_attributes_org_state_idx     ON public.contact_attributes (org_id, state);
CREATE INDEX contact_attributes_org_dob_idx       ON public.contact_attributes (org_id, dob);
```

Five, not nine, and the omissions are the point:

- **`interest_tag` and `partner_slug`** are the two dimensions Drip routes on (interest tag is the
  *required* drip audience field, partner slug the optional filter), so they are hot by design.
- **`state`** is the highest-cardinality optional filter.
- **`dob`** is indexed because the age-band predicate below is a **range on `dob`**, which an index
  can serve. (It would be useless if age were computed per row — see the next section.)
- **`gender`, `kids`, `married`, `country`, `income_band` get no index.** Two to six distinct
  values over what will become hundreds of thousands of rows: Postgres will seq-scan regardless,
  and a btree there costs write throughput on the intake path for nothing. They will be used in
  *combination* with a selective rule, and the segment evaluator INTERSECTs per-branch sets — so
  the selective branch drives the plan.
- **No GIN on `extra`** until a query needs it. Precedent: on the creatives list an index measured
  *worse* than none, so speculative indexes are not free here.
- **`org_id` leads every composite** by convention. Note it adds no selectivity today (one org,
  815,426 contacts) — it is there so the shape is right when a second org exists.

---

## Age and under-18, derived in SQL

**The key design decision: never compute age per row. Invert it — turn the band into a `dob`
range, computed once per query.**

Naive and *wrong* for our purposes:

```sql
-- ✗ not sargable: a function of dob and now() on every row, so
--   contact_attributes_org_dob_idx can never be used
EXTRACT(YEAR FROM age(ca.dob))::int BETWEEN 25 AND 34
```

Proposed and index-usable:

```sql
-- ✓ a plain range on dob; the index applies
ca.dob >  (CURRENT_DATE - INTERVAL '35 years')   -- age <= 34
AND ca.dob <= (CURRENT_DATE - INTERVAL '25 years')  -- age >= 25
```

This is the same reasoning as the per-carrier daily cap (`07-conventions.md`), which passes an ET
day as a **timestamptz range** rather than applying a function to `sent_at`, precisely so the
partial index survives.

Band → `dob` range (upper bound exclusive on the older side, so bands neither overlap nor gap):

| band | predicate |
|---|---|
| 18–24 | `dob > CURRENT_DATE - INTERVAL '25 years' AND dob <= CURRENT_DATE - INTERVAL '18 years'` |
| 25–34 | `dob > CURRENT_DATE - INTERVAL '35 years' AND dob <= CURRENT_DATE - INTERVAL '25 years'` |
| 35–44 | `dob > CURRENT_DATE - INTERVAL '45 years' AND dob <= CURRENT_DATE - INTERVAL '35 years'` |
| 45–54 | `dob > CURRENT_DATE - INTERVAL '55 years' AND dob <= CURRENT_DATE - INTERVAL '45 years'` |
| 55–64 | `dob > CURRENT_DATE - INTERVAL '65 years' AND dob <= CURRENT_DATE - INTERVAL '55 years'` |
| 65+   | `dob <= CURRENT_DATE - INTERVAL '65 years'` |

Concrete cutoffs as of 2026-08-21 (from the DB): 18 ⇒ `2008-08-21`, 25 ⇒ `2001-08-21`,
35 ⇒ `1991-08-21`, 65 ⇒ `1961-08-21`.

**The emitted rule SQL**, following the `phone_type` / `carrier` shape exactly (a bare
`SELECT … contact_id`, so the set-arithmetic evaluator can INTERSECT/EXCEPT it):

```sql
SELECT ca.contact_id
FROM contact_attributes ca
JOIN contacts c ON c.id = ca.contact_id
WHERE ca.org_id = $1::uuid
  AND c.messaging_status = 'eligible'
  -- (B) HARD FLOOR: never anyone under 18, whatever band was selected.
  --     Independent of the band predicate on purpose — a future band edit
  --     cannot lower it, and it is one line to audit.
  AND ca.dob <= CURRENT_DATE - INTERVAL '18 years'
  -- (A) NULL dob matches nothing. Implicit in the comparison above (NULL <= x
  --     is NULL, not true) and therefore not separately spelled — but stated
  --     here because it is a decision, not an accident.
  AND ( <band range predicates, OR'd across the selected bands> )
```

Three properties worth stating because each is a decision:

1. **`ca.dob <= CURRENT_DATE - INTERVAL '18 years'` also does the NULL work.** `NULL <= date` is
   NULL, which `WHERE` treats as not-true, so a NULL `dob` is excluded without a separate
   `IS NOT NULL`. I would still keep the floor explicit rather than relying on the band ranges
   alone, so the rule reads as the compliance statement it is.
2. **`is_not` is safe.** Under `EXCEPT`, an `is_not age_band` rule subtracts this set. Because the
   set excludes unknown-dob contacts, `is_not` does **not** sweep them in — it removes only people
   we can positively place in the band. That is the conservative direction. `isRuleComplete` must
   stay identical-or-stronger than the emitter's fallback here, or an incomplete `is_not` flips
   "nobody" into "everybody" (the documented trap).
3. **The `messaging_status = 'eligible'` join** mirrors `phone_type`/`carrier`. It costs a PK
   lookup per row. If measurement says it is redundant with the outer audience layers, it can be
   dropped — but not silently.

**Timezone note:** `CURRENT_DATE` is the server's date (UTC). The campaign timezone is ET, so for
~4–5 hours a day a birthday flips a day earlier than an ET operator would expect. For an age
*band* this shifts at most one person by one day at a boundary, and it self-corrects. I propose
leaving it as `CURRENT_DATE` rather than `(now() AT TIME ZONE 'America/New_York')::date` — the
latter is still sargable, so this is reversible either way. **Say if you want ET.**

---

## Open questions before I write the migration

1. **Confirm C stays out of scope** — no global minor-gate in 1c. (With 0 known `dob` values, a
   global NULL-excludes rule would zero every audience.)
2. **`CURRENT_DATE` (UTC) or ET for the age cutoffs?** UTC proposed; both are index-friendly.
3. **`1970-01-01` as a fake "missing" DOB.** The sanity CHECK catches year 0001 and future dates
   but not the epoch, which imports frequently emit for a blank. Reject it at the Zod boundary
   (my preference), add it to the CHECK, or accept it?
4. **`email` — any uniqueness or normalization?** Proposed: store as given, lowercase-trim at the
   write boundary, **no unique constraint** (partners legitimately share addresses, and a unique
   index would make an import fail on a duplicate rather than update).
5. **Backfill: none.** The table starts empty; existing contacts get attributes only when a drip
   lead or a mapped CSV touches them. Confirm.

Nothing will be written until these are answered and the migration is approved.
