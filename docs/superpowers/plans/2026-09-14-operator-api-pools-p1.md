# Operator API Pools — PR 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GET /api/audience/pools?offer_id=&rest_days=` — per contact group, how many eligible contacts could still be sent an offer (never received × rested, re-touch and clicker pools), served from a 30-minute rollup.

**Architecture:** Migration 0178 adds `operator_rollups` (one row per org × rollup key). A cron runs one org-wide aggregate statement that buckets every eligible contact by whole days since its last sent message (0..30, 31 = 31+ or never) per active group and per offer, and stores the histograms. The endpoint reads one offer's histograms and sums buckets ≥ `rest_days`. Pure arithmetic lives in an import-free module.

**Tech Stack:** Next.js 16 route handlers · Drizzle raw `sql` on postgres-js · Supabase Postgres · Vercel Cron · tsx verification scripts.

Spec: [../specs/2026-09-14-operator-api-pools-creative-design.md](../specs/2026-09-14-operator-api-pools-creative-design.md) §1, §2, §4, §5.

## Global Constraints

- Read-only, aggregate-only: group names, offer ids and integers. No contact ids, no phone numbers in the blob or the response.
- Every query filters `org_id`.
- Eligible = `contacts.is_archived = false` AND no `opt_outs` row.
- Received = `stage_sends.status = 'sent'` on a campaign of the offer (`campaigns.offer_id`).
- Rested N = last `status='sent'` send of ANY offer is ≥ N whole days before the snapshot `now()`, or never messaged; buckets 0..30 plus 31.
- Human click = a `counted_clickers` row on a campaign of the offer. Converted = a `status='sent'` send of the offer with `converted_at IS NOT NULL`.
- Groups = `contact_groups.status = 'active'`; a contact in two groups counts in both; `totals` = all eligible contacts.
- `rest_days` integer 0–30, default 7. `offer_id` required positive int4; 404 outside the org.
- 503 `rollup_not_ready` before the first run; 503 `offer_not_in_rollup_yet` only for an offer absent from the snapshot that HAS a sent message.
- Cron `29,59 * * * *`, `withCronLease` with a 6-minute TTL, `maxDuration = 300`, default `work_mem`.
- Permission `contacts.stats`; route map `"audience/pools": { methods: ["GET"], token: ["GET"] }`, `"cron/refresh-audience-pools": null`.
- Never interpolate a JS array into a `sql` template.

## File map

| File | Change |
|---|---|
| `db/migrations/0178_operator_rollups.sql` | **Create.** Table + RLS policy |
| `db/migrations/meta/_journal.json` | Append idx 178 |
| `db/migrations/meta/0178_snapshot.json` | **Create.** Copy of 0177 with new `id` / `prevId` |
| `db/schema.ts` | `operator_rollups` table after `audience_fresh_counts` |
| `lib/audience/pool-math.ts` | **Create.** `REST_BUCKETS`, `REST_DAYS_MAX`, `REST_DAYS_DEFAULT`, `restedCount()`, `poolCounts()` and types |
| `lib/audience/pools.ts` | **Create.** `computeAudiencePools()`, `refreshAudiencePools()`, `readAudiencePools()` |
| `app/api/audience/pools/route.ts` | **Create.** GET |
| `app/api/cron/refresh-audience-pools/route.ts` | **Create.** Cron |
| `vercel.json` | Cron entry `29,59 * * * *` |
| `lib/authz/route-map.ts` | Two entries |
| `scripts/test-audience-pool-math.ts` | **Create.** Pure checks |
| `scripts/verify-audience-pools.ts` | **Create.** Lib vs independent recount in one REPEATABLE READ transaction |
| `scripts/verify-operator-grading-http.ts` | Section 11 (pools) |
| docs | operator-api.md (§1 failure table, §2 Pools, §9 line), 03-data-model.md (+ERD), 04-features/crons.md, 04-features/operator-api-tokens.md, 07-conventions.md, CHANGELOG.md |

---

### Task 1: Migration 0178 + schema

**Files:**
- Create: `db/migrations/0178_operator_rollups.sql`, `db/migrations/meta/0178_snapshot.json`
- Modify: `db/migrations/meta/_journal.json`, `db/schema.ts`

**Interfaces:**
- Produces: table `public.operator_rollups (org_id uuid, rollup_key text, data jsonb, computed_at timestamptz, duration_ms integer, updated_at timestamptz)`, PK `(org_id, rollup_key)`; Drizzle export `operator_rollups`.

- [ ] **Step 1: Write the migration**

```sql
-- operator_rollups — saved results behind operator-API endpoints whose live
-- computation is too slow to run per request. One row per (org, rollup_key),
-- refreshed by a cron, read by the endpoint, the timestamp travelling with the
-- answer so it is never presented as live. Generalises audience_fresh_counts
-- (0176) so each new rollup is a key, not a migration.
--
-- Keys: 'audience_pools' (GET /api/audience/pools, cron refresh-audience-pools),
-- 'performance_creative_lifetime' (GET /api/reports/performance
-- dimension=creative range=lifetime). Spec:
-- docs/superpowers/specs/2026-09-14-operator-api-pools-creative-design.md
--
-- ⚠️ THE BLOBS HOLD ONLY AGGREGATES — group names, offer / creative ids and
-- integers. No contact ids, no phone numbers, nothing to strip at the response
-- boundary.
CREATE TABLE IF NOT EXISTS public.operator_rollups (
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  rollup_key text NOT NULL,
  data jsonb,
  -- The instant the numbers describe. NULL until the first cron run: the
  -- endpoint answers 503, never a misleading zero.
  computed_at timestamptz,
  duration_ms integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, rollup_key)
);
--> statement-breakpoint
ALTER TABLE public.operator_rollups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "operator_rollups_select_own_org"
  ON public.operator_rollups FOR SELECT
  USING (org_id = public.current_org_id());
```

- [ ] **Step 2: Journal + snapshot** — append to `_journal.json` `entries`:

```json
    {
      "idx": 178,
      "version": "7",
      "when": 1791763200000,
      "tag": "0178_operator_rollups",
      "breakpoints": true
    }
```

and create `0178_snapshot.json` as a copy of `0177_snapshot.json` with `"id": "0178a000-0178-4178-8178-000000000178"` and `"prevId": "0177a000-0177-4177-8177-000000000177"` (the snapshots have not tracked tables since 0176; 0176 and 0177 are identical).

- [ ] **Step 3: Drizzle table** — in `db/schema.ts` after `export type AudienceFreshCounts …`:

```ts
// ── operator_rollups (migration 0178) ──────────────────────────────────────
//
// Saved results behind operator-API endpoints too slow to compute per request:
// one row per (org, rollup_key), refreshed by a cron, read by the endpoint.
// Keys: "audience_pools" (lib/audience/pools.ts) and
// "performance_creative_lifetime". Like audience_fresh_counts, the blob holds
// only group names, ids of offers / creatives and integers — never a contact.
export const operator_rollups = pgTable(
  "operator_rollups",
  {
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    rollup_key: text("rollup_key").notNull(),
    data: jsonb("data"),
    // NULL until the first cron run — the endpoint answers 503, not zeros.
    computed_at: timestamp("computed_at", { withTimezone: true }),
    duration_ms: integer("duration_ms"),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.org_id, table.rollup_key] })],
);

export type OperatorRollup = typeof operator_rollups.$inferSelect;
```

- [ ] **Step 4: Prove the SQL on the preview project without residue** (camman-v2 `fdzxzxayhknywvmrhjcj`): run the three statements inside `DO $$ BEGIN … RAISE EXCEPTION 'TESTRESULT ok'; END $$;`. Expected: error text `TESTRESULT ok` (everything rolled back).
- [ ] **Step 5: `npx tsc --noEmit`** — expected exit 0.
- [ ] **Step 6: Commit** the four files (`feat(db): 0178 operator_rollups`).
- [ ] **Step 7: Apply to production** — `npm run db:migrate`, then `npx tsx scripts/verify-migration-integrity.ts`. Expected: 0178 applied, integrity OK. Confirm: `SELECT count(*) FROM operator_rollups` → 0.

### Task 2: Pool math + rollup lib + lib verification

**Files:**
- Create: `lib/audience/pool-math.ts`, `lib/audience/pools.ts`, `scripts/test-audience-pool-math.ts`, `scripts/verify-audience-pools.ts`

**Interfaces:**
- Consumes: `operator_rollups` (Task 1).
- Produces:
  - `restedCount(h: RestHistogram | undefined, restDays: number): number`
  - `poolCounts(base: HistogramsByGroup, offer: OfferHistograms | undefined, key: string, restDays: number): PoolCounts`
  - `computeAudiencePools(dbc: DbOrTx, orgId: string): Promise<{ snapshot: PoolsSnapshot; snapshotAt: string }>`
  - `refreshAudiencePools(orgId: string): Promise<{ durationMs: number }>`
  - `readAudiencePools(orgId: string, offerId: number, restDays: number): Promise<AudiencePoolsResult>` where `AudiencePoolsResult = { status: "ok"; pools: AudiencePools } | { status: "offer_not_found" } | { status: "rollup_not_ready" } | { status: "offer_not_in_rollup_yet" }`

- [ ] **Step 1: Write `scripts/test-audience-pool-math.ts`** (pure; fails first because the module does not exist)

```ts
// Pure checks for lib/audience/pool-math.ts. No database.
// Run: npx tsx scripts/test-audience-pool-math.ts
import {
  poolCounts,
  REST_BUCKETS,
  restedCount,
  type HistogramsByGroup,
  type OfferHistograms,
} from "../lib/audience/pool-math";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}
const hist = (entries: Record<number, number>) =>
  Array.from({ length: REST_BUCKETS }, (_, b) => entries[b] ?? 0);

// Group "7": 100 eligible — 10 messaged today, 20 three days ago, 30 ten days
// ago, 40 never (bucket 31). The org total adds 5 never-messaged outside the group.
const base: HistogramsByGroup = {
  "7": hist({ 0: 10, 3: 20, 10: 30, 31: 40 }),
  total: hist({ 0: 10, 3: 20, 10: 30, 31: 45 }),
};
// The offer reached 25 of them (10 today, 15 ten days ago): 12 neither clicked
// nor converted (5 today, 7 ten days ago), 6 clicked without buying (2 today,
// 4 ten days ago).
const offer: OfferHistograms = {
  received: { "7": hist({ 0: 10, 10: 15 }) },
  received_not_clicked: { "7": hist({ 0: 5, 10: 7 }) },
  clickers_non_buyers: { "7": hist({ 0: 2, 10: 4 }) },
};

check("restedCount of an absent histogram is 0", restedCount(undefined, 7) === 0);
check("restedCount at 0 sums every bucket", restedCount(base["7"], 0) === 100);
check("restedCount at 7 keeps buckets >= 7", restedCount(base["7"], 7) === 70);
check("bucket 31 (31+ days or never) is rested at rest_days 30", restedCount(base["7"], 30) === 40);

const g7 = poolCounts(base, offer, "7", 7);
check("group_total_eligible", g7.group_total_eligible === 100, g7);
check("never_received = eligible - received", g7.never_received === 75, g7);
check("never_received_rested = rested eligible - rested received", g7.never_received_rested === 55, g7);
check("received_not_clicked_rested", g7.received_not_clicked_rested === 7, g7);
check("clickers_non_buyers", g7.clickers_non_buyers === 6, g7);
check("clickers_non_buyers_rested", g7.clickers_non_buyers_rested === 4, g7);

const g0 = poolCounts(base, offer, "7", 0);
check(
  "rest_days 0: every rested count equals its unrested count",
  g0.never_received_rested === g0.never_received && g0.clickers_non_buyers_rested === g0.clickers_non_buyers,
  g0,
);
let monotone = true;
let prev = g0;
for (let n = 1; n <= 30; n++) {
  const cur = poolCounts(base, offer, "7", n);
  if (
    cur.never_received_rested > prev.never_received_rested ||
    cur.received_not_clicked_rested > prev.received_not_clicked_rested ||
    cur.clickers_non_buyers_rested > prev.clickers_non_buyers_rested
  ) {
    monotone = false;
  }
  prev = cur;
}
check("every rested count is non-increasing in rest_days", monotone);

const never = poolCounts(base, undefined, "7", 7);
check(
  "an offer that never sent: never_received = eligible, the rest 0",
  never.never_received === 100 &&
    never.never_received_rested === 70 &&
    never.received_not_clicked_rested === 0 &&
    never.clickers_non_buyers === 0,
  never,
);
check("a group key absent from the snapshot counts 0", poolCounts(base, offer, "999", 7).group_total_eligible === 0);
check("the totals key reads the org histogram", poolCounts(base, undefined, "total", 0).group_total_eligible === 105);

console.log(failures === 0 ? "\ntest-audience-pool-math OK." : `\nFAILED: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it** — `npx tsx scripts/test-audience-pool-math.ts`. Expected: FAIL (cannot find module `../lib/audience/pool-math`).

- [ ] **Step 3: Write `lib/audience/pool-math.ts`**

```ts
// Pure arithmetic behind GET /api/audience/pools. No imports, so
// scripts/test-audience-pool-math.ts runs without a database.
//
// The rollup stores, per contact group and per offer, how many eligible contacts
// sit in each REST BUCKET: whole days since the contact's last sent message of
// ANY offer, 0..30, with bucket 31 meaning "31 days or more, or never messaged".
// "Rested for N days" is then every bucket >= N, exact for any N in 0..30.

export const REST_BUCKETS = 32;
export const REST_DAYS_MAX = 30;
export const REST_DAYS_DEFAULT = 7;

/** Contacts per rest bucket; index = whole days since last send (31 = 31+ or never). */
export type RestHistogram = number[];

/** Histograms keyed by contact group id, plus "total" for the whole org. */
export type HistogramsByGroup = Record<string, RestHistogram>;

export interface OfferHistograms {
  /** Eligible contacts with at least one sent message of the offer. */
  received: HistogramsByGroup;
  /** Of those: no human click on the offer and no conversion on it. */
  received_not_clicked: HistogramsByGroup;
  /** Of those: a human click on the offer and no conversion on it. */
  clickers_non_buyers: HistogramsByGroup;
}

export interface PoolCounts {
  group_total_eligible: number;
  never_received: number;
  never_received_rested: number;
  received_not_clicked_rested: number;
  clickers_non_buyers: number;
  clickers_non_buyers_rested: number;
}

/** Sum of the buckets >= restDays; restDays 0 sums the whole histogram. */
export function restedCount(h: RestHistogram | undefined, restDays: number): number {
  if (!h) return 0;
  let n = 0;
  for (let b = restDays; b < h.length; b++) n += h[b];
  return n;
}

/**
 * The six pool numbers for one key ("total" or a group id). `offer` is undefined
 * for an offer that has never sent: every received set is empty.
 */
export function poolCounts(
  base: HistogramsByGroup,
  offer: OfferHistograms | undefined,
  key: string,
  restDays: number,
): PoolCounts {
  const eligible = restedCount(base[key], 0);
  return {
    group_total_eligible: eligible,
    never_received: eligible - restedCount(offer?.received[key], 0),
    never_received_rested:
      restedCount(base[key], restDays) - restedCount(offer?.received[key], restDays),
    received_not_clicked_rested: restedCount(offer?.received_not_clicked[key], restDays),
    clickers_non_buyers: restedCount(offer?.clickers_non_buyers[key], 0),
    clickers_non_buyers_rested: restedCount(offer?.clickers_non_buyers[key], restDays),
  };
}
```

- [ ] **Step 4: Run it** — expected `test-audience-pool-math OK.` (15 checks).

- [ ] **Step 5: Write `lib/audience/pools.ts`**

```ts
import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  poolCounts,
  REST_BUCKETS,
  type HistogramsByGroup,
  type OfferHistograms,
  type PoolCounts,
} from "@/lib/audience/pool-math";

// "How many contacts could still be sent offer X?" — the rollup behind
// GET /api/audience/pools. Spec:
// docs/superpowers/specs/2026-09-14-operator-api-pools-creative-design.md
//
// ⚠️ REST IS MEASURED FROM THE LAST MESSAGE ACTUALLY SENT, of ANY offer — not
// from campaign creation like fresh-counts. That is the question a strategy
// decision asks ("when did this person last hear from us"), and it is why this
// rollup reads stage_sends, which fresh-counts deliberately avoids.
//
// ⚠️ ONE ORG-WIDE PASS COVERS EVERY OFFER. "Rested" needs each contact's last
// send of any offer, so the stage_sends scan is org-wide whatever the offer
// count; grouping it by (contact, offer) in the same pass makes every offer free.
// Measured 2026-09-14 on prod: 40.2s at default work_mem (31.2s at 128MB) for 40
// offers × 12 active groups × 32 rest buckets = 4,170 aggregate rows. Default
// work_mem is kept on purpose: this database also runs the send drain.
//
// ⚠️ THE BLOB HOLDS ONLY GROUP ids / NAMES, OFFER ids AND INTEGERS. No contact
// ids, no phone numbers — nothing to strip at the response boundary.

export type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const POOLS_ROLLUP_KEY = "audience_pools";

export const POOLS_DEFINITION =
  "eligible = not archived and not opted out; received = at least one sent message of this offer; rested = the contact's last sent message of ANY offer was at least rest_days before computed_at, or never messaged; human click = a counted human clicker on this offer; converted = a tracker conversion on this offer's messages";

export interface PoolsSnapshot {
  version: 1;
  /** Active contact groups at compute time; a group with no eligible contact reports zeros. */
  groups: { id: number; name: string }[];
  /** Eligible contacts per rest bucket, per group id and "total". */
  base: HistogramsByGroup;
  /** Per offer id — only offers with at least one sent message. */
  offers: Record<string, OfferHistograms>;
}

interface AggRow {
  kind: "base" | "offer" | "snapshot";
  offer_id: number | null;
  group_id: number | null;
  bucket: number | null;
  n: number;
  not_clicked: number;
  non_buyers: number;
  snapshot_at: string | null;
}

const emptyHistogram = () => Array.from({ length: REST_BUCKETS }, () => 0);

function addTo(map: HistogramsByGroup, key: string, bucket: number, n: number) {
  (map[key] ??= emptyHistogram())[bucket] += n;
}

/**
 * Compute the pool histograms for one org. Read-only. Takes a db handle so the
 * verification can run it inside a REPEATABLE READ transaction next to an
 * independent recount.
 *
 * ⚠️ `MATERIALIZED` is load-bearing: `last_pair`, `eligible`, `memb` and
 * `offer_rows` are each read by two branches, and inlined the planner would
 * repeat the stage_sends scan per branch.
 */
export async function computeAudiencePools(
  dbc: DbOrTx,
  orgId: string,
): Promise<{ snapshot: PoolsSnapshot; snapshotAt: string }> {
  const groups = (await dbc.execute(sql`
    SELECT id, name FROM contact_groups
    WHERE org_id = ${orgId}::uuid AND status = 'active'
    ORDER BY name
  `)) as unknown as { id: number; name: string }[];

  const rows = (await dbc.execute(sql`
    WITH last_pair AS MATERIALIZED (
      SELECT ss.contact_id, c.offer_id, max(ss.sent_at) AS last_sent,
             bool_or(ss.converted_at IS NOT NULL) AS converted
      FROM stage_sends ss
      JOIN campaigns c ON c.id = ss.campaign_id
      WHERE ss.org_id = ${orgId}::uuid AND ss.status = 'sent'
      GROUP BY 1, 2
    ),
    last_any AS MATERIALIZED (
      SELECT contact_id, max(last_sent) AS last_sent FROM last_pair GROUP BY 1
    ),
    clicked AS MATERIALIZED (
      SELECT DISTINCT cc.contact_id, c.offer_id
      FROM counted_clickers cc
      JOIN campaigns c ON c.id = cc.campaign_id
      WHERE cc.org_id = ${orgId}::uuid
    ),
    eligible AS MATERIALIZED (
      SELECT ct.id,
             -- least() ignores NULL, so a never-messaged contact lands in 31.
             least(31, floor(extract(epoch FROM (now() - la.last_sent)) / 86400))::int AS bucket
      FROM contacts ct
      LEFT JOIN last_any la ON la.contact_id = ct.id
      WHERE ct.org_id = ${orgId}::uuid
        AND ct.is_archived = false
        AND NOT EXISTS (
          SELECT 1 FROM opt_outs o
          WHERE o.org_id = ${orgId}::uuid AND o.contact_id = ct.id
        )
    ),
    memb AS MATERIALIZED (
      SELECT e.id, e.bucket, j.contact_group_id AS group_id
      FROM eligible e
      JOIN contact_contact_groups j ON j.contact_id = e.id
      JOIN contact_groups g ON g.id = j.contact_group_id
        AND g.org_id = ${orgId}::uuid AND g.status = 'active'
    ),
    offer_rows AS MATERIALIZED (
      SELECT lp.offer_id, lp.contact_id, lp.converted,
             (ck.contact_id IS NOT NULL) AS clicked
      FROM last_pair lp
      LEFT JOIN clicked ck ON ck.contact_id = lp.contact_id AND ck.offer_id = lp.offer_id
      WHERE lp.offer_id IS NOT NULL
    )
    SELECT 'base' AS kind, NULL::int AS offer_id, group_id, bucket,
           count(*)::int AS n, 0 AS not_clicked, 0 AS non_buyers, NULL::text AS snapshot_at
    FROM memb GROUP BY group_id, bucket
    UNION ALL
    SELECT 'base', NULL, NULL, bucket, count(*)::int, 0, 0, NULL
    FROM eligible GROUP BY bucket
    UNION ALL
    SELECT 'offer', o.offer_id, m.group_id, m.bucket, count(*)::int,
           (count(*) FILTER (WHERE NOT o.clicked AND NOT o.converted))::int,
           (count(*) FILTER (WHERE o.clicked AND NOT o.converted))::int,
           NULL
    FROM offer_rows o JOIN memb m ON m.id = o.contact_id
    GROUP BY o.offer_id, m.group_id, m.bucket
    UNION ALL
    SELECT 'offer', o.offer_id, NULL, e.bucket, count(*)::int,
           (count(*) FILTER (WHERE NOT o.clicked AND NOT o.converted))::int,
           (count(*) FILTER (WHERE o.clicked AND NOT o.converted))::int,
           NULL
    FROM offer_rows o JOIN eligible e ON e.id = o.contact_id
    GROUP BY o.offer_id, e.bucket
    UNION ALL
    SELECT 'snapshot', NULL, NULL, NULL, 0, 0, 0,
           to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  `)) as unknown as AggRow[];

  const snapshot: PoolsSnapshot = {
    version: 1,
    groups: groups.map((g) => ({ id: Number(g.id), name: g.name })),
    base: {},
    offers: {},
  };
  let snapshotAt: string | null = null;
  for (const r of rows) {
    if (r.kind === "snapshot") {
      snapshotAt = r.snapshot_at;
      continue;
    }
    const key = r.group_id == null ? "total" : String(r.group_id);
    const bucket = Number(r.bucket);
    if (r.kind === "base") {
      addTo(snapshot.base, key, bucket, Number(r.n));
      continue;
    }
    const offer = (snapshot.offers[String(r.offer_id)] ??= {
      received: {},
      received_not_clicked: {},
      clickers_non_buyers: {},
    });
    addTo(offer.received, key, bucket, Number(r.n));
    addTo(offer.received_not_clicked, key, bucket, Number(r.not_clicked));
    addTo(offer.clickers_non_buyers, key, bucket, Number(r.non_buyers));
  }
  if (!snapshotAt) throw new Error("audience pools: the snapshot row is missing");
  return { snapshot, snapshotAt };
}

/** Recompute and store the rollup for one org. */
export async function refreshAudiencePools(orgId: string): Promise<{ durationMs: number }> {
  const startedAt = Date.now();
  const { snapshot, snapshotAt } = await computeAudiencePools(db, orgId);
  const durationMs = Date.now() - startedAt;

  await db.execute(sql`
    INSERT INTO operator_rollups (org_id, rollup_key, data, computed_at, duration_ms, updated_at)
    VALUES (${orgId}::uuid, ${POOLS_ROLLUP_KEY}, ${JSON.stringify(snapshot)}::jsonb,
            ${snapshotAt}::timestamptz, ${durationMs}, now())
    ON CONFLICT (org_id, rollup_key) DO UPDATE
      SET data = EXCLUDED.data,
          computed_at = EXCLUDED.computed_at,
          duration_ms = EXCLUDED.duration_ms,
          updated_at = now()
  `);
  return { durationMs };
}

export interface AudiencePoolRow extends PoolCounts {
  group_name: string;
}

export interface AudiencePools {
  offer_id: number;
  offer_name: string;
  rest_days: number;
  data: AudiencePoolRow[];
  totals: PoolCounts;
  computed_at: string;
  stale_seconds: number;
  definition: string;
}

export type AudiencePoolsResult =
  | { status: "ok"; pools: AudiencePools }
  | { status: "offer_not_found" }
  | { status: "rollup_not_ready" }
  | { status: "offer_not_in_rollup_yet" };

/** Read one offer's pools from the stored rollup. */
export async function readAudiencePools(
  orgId: string,
  offerId: number,
  restDays: number,
): Promise<AudiencePoolsResult> {
  const offer = (await db.execute(sql`
    SELECT id, name FROM offers WHERE org_id = ${orgId}::uuid AND id = ${offerId}
  `)) as unknown as { id: number; name: string }[];
  if (!offer[0]) return { status: "offer_not_found" };

  // Only the requested offer's histograms leave the database.
  const stored = (await db.execute(sql`
    SELECT data->'groups' AS groups,
           data->'base' AS base,
           data->'offers'->${String(offerId)}::text AS offer,
           to_char(computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS computed_at
    FROM operator_rollups
    WHERE org_id = ${orgId}::uuid AND rollup_key = ${POOLS_ROLLUP_KEY}
      AND data IS NOT NULL AND computed_at IS NOT NULL
  `)) as unknown as {
    groups: PoolsSnapshot["groups"];
    base: HistogramsByGroup;
    offer: OfferHistograms | null;
    computed_at: string;
  }[];
  const row = stored[0];
  if (!row) return { status: "rollup_not_ready" };

  if (row.offer == null) {
    // Absent from the snapshot. Exact when the offer has never sent (every
    // received set is empty); otherwise its first send came after the snapshot.
    const sent = (await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM stage_sends ss
        JOIN campaigns c ON c.id = ss.campaign_id
        WHERE ss.org_id = ${orgId}::uuid AND c.org_id = ${orgId}::uuid
          AND c.offer_id = ${offerId} AND ss.status = 'sent'
      ) AS sent
    `)) as unknown as { sent: boolean }[];
    if (sent[0]?.sent) return { status: "offer_not_in_rollup_yet" };
  }

  const offerHistograms = row.offer ?? undefined;
  const data = row.groups
    .map((g) => ({
      group_name: g.name,
      ...poolCounts(row.base, offerHistograms, String(g.id), restDays),
    }))
    .sort(
      (a, b) =>
        b.group_total_eligible - a.group_total_eligible || a.group_name.localeCompare(b.group_name),
    );

  return {
    status: "ok",
    pools: {
      offer_id: Number(offer[0].id),
      offer_name: offer[0].name,
      rest_days: restDays,
      data,
      totals: poolCounts(row.base, offerHistograms, "total", restDays),
      computed_at: row.computed_at,
      stale_seconds: Math.max(0, Math.round((Date.now() - Date.parse(row.computed_at)) / 1000)),
      definition: POOLS_DEFINITION,
    },
  };
}
```

- [ ] **Step 6: Write `scripts/verify-audience-pools.ts`**

```ts
// Lib-level verification for GET /api/audience/pools. READ-ONLY against the
// database in .env.local (production).
//
// ⚠️ The rollup statement and an INDEPENDENT per-contact recount (per-offer
// sets + a NOT EXISTS probe on the (org_id, phone, sent_at) index — no rest
// buckets) run inside ONE REPEATABLE READ, READ ONLY transaction, so both see
// the same rows and the same now(). Live sends cannot race the comparison.
// Run: npx tsx --conditions=react-server scripts/verify-audience-pools.ts
import "./_env-preload";

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { poolCounts, restedCount, type PoolCounts } from "@/lib/audience/pool-math";
import { computeAudiencePools } from "@/lib/audience/pools";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

const FIELDS: (keyof PoolCounts)[] = [
  "group_total_eligible",
  "never_received",
  "never_received_rested",
  "received_not_clicked_rested",
  "clickers_non_buyers",
  "clickers_non_buyers_rested",
];
const REST_CHECKS = [0, 7, 30] as const;

async function main() {
  const [{ org_id: orgId }] = (await db.execute(sql`
    SELECT org_id FROM campaigns GROUP BY org_id ORDER BY count(*) DESC LIMIT 1`)) as unknown as {
    org_id: string;
  }[];

  await db.transaction(
    async (tx) => {
      // The rollup alone is ~40s; the recount probes per contact.
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '600s'"));

      console.log("A. computeAudiencePools");
      const t = Date.now();
      const { snapshot, snapshotAt } = await computeAudiencePools(tx, orgId);
      console.log(
        `    ${Date.now() - t}ms at ${snapshotAt}: ${snapshot.groups.length} active groups, ${Object.keys(snapshot.offers).length} offers with sends`,
      );

      const [{ n: eligibleTruth }] = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM contacts ct
        WHERE ct.org_id = ${orgId}::uuid AND ct.is_archived = false
          AND NOT EXISTS (SELECT 1 FROM opt_outs o WHERE o.org_id = ${orgId}::uuid AND o.contact_id = ct.id)`)) as unknown as {
        n: number;
      }[];
      check(
        "totals: group_total_eligible = an independent eligible count",
        poolCounts(snapshot.base, undefined, "total", 0).group_total_eligible === Number(eligibleTruth),
        { got: poolCounts(snapshot.base, undefined, "total", 0).group_total_eligible, want: eligibleTruth },
      );

      console.log("\nB. invariants over every offer × group × rest_days 0..30");
      let violations = 0;
      let clickerCells = 0;
      let retouchCells = 0;
      const keys = ["total", ...snapshot.groups.map((g) => String(g.id))];
      for (const offer of Object.values(snapshot.offers)) {
        for (const key of keys) {
          const received = restedCount(offer.received[key], 0);
          let prev: PoolCounts | null = null;
          for (let n = 0; n <= 30; n++) {
            const c = poolCounts(snapshot.base, offer, key, n);
            if (c.never_received < 0 || c.never_received_rested < 0) violations++;
            if (c.clickers_non_buyers + restedCount(offer.received_not_clicked[key], 0) > received) violations++;
            if (n === 0 && (c.never_received_rested !== c.never_received || c.clickers_non_buyers_rested !== c.clickers_non_buyers)) violations++;
            if (
              prev &&
              (c.never_received_rested > prev.never_received_rested ||
                c.received_not_clicked_rested > prev.received_not_clicked_rested ||
                c.clickers_non_buyers_rested > prev.clickers_non_buyers_rested)
            ) {
              violations++;
            }
            prev = c;
          }
          const at7 = poolCounts(snapshot.base, offer, key, 7);
          if (key !== "total" && at7.clickers_non_buyers > 0) clickerCells++;
          if (key !== "total" && at7.received_not_clicked_rested > 0) retouchCells++;
        }
      }
      check("no negative, over-received, rest_days-0 or monotonicity violation", violations === 0, violations);
      check("control: some offer × group has clickers_non_buyers", clickerCells > 0, clickerCells);
      check("control: some offer × group has received_not_clicked_rested at 7", retouchCells > 0, retouchCells);

      console.log("\nC. independent recount — two offers × two groups × rest_days 0 / 7 / 30");
      const groups = snapshot.groups
        .map((g) => ({ ...g, eligible: restedCount(snapshot.base[String(g.id)], 0) }))
        .filter((g) => g.eligible >= 1_000 && g.eligible <= 60_000)
        .sort((a, b) => b.eligible - a.eligible)
        .slice(0, 2);
      const offers = Object.entries(snapshot.offers)
        .map(([id, o]) => ({ id: Number(id), received: restedCount(o.received.total, 0) }))
        .sort((a, b) => b.received - a.received)
        .slice(0, 2);
      check("control: two mid-size active groups and two offers to recount", groups.length === 2 && offers.length === 2, { groups, offers });
      let recentSeen = false;
      for (const o of offers) {
        for (const g of groups) {
          const [truth] = (await tx.execute(sql`
            WITH e AS MATERIALIZED (
              SELECT ct.id, ct.phone_number FROM contacts ct
              JOIN contact_contact_groups j ON j.contact_id = ct.id AND j.contact_group_id = ${g.id}
              WHERE ct.org_id = ${orgId}::uuid AND ct.is_archived = false
                AND NOT EXISTS (SELECT 1 FROM opt_outs x WHERE x.org_id = ${orgId}::uuid AND x.contact_id = ct.id)
            ),
            rc AS MATERIALIZED (
              SELECT s.contact_id, bool_or(s.converted_at IS NOT NULL) AS converted
              FROM stage_sends s JOIN campaigns c ON c.id = s.campaign_id
              WHERE s.org_id = ${orgId}::uuid AND c.org_id = ${orgId}::uuid
                AND c.offer_id = ${o.id} AND s.status = 'sent'
              GROUP BY 1
            ),
            ck AS MATERIALIZED (
              SELECT DISTINCT cc.contact_id FROM counted_clickers cc
              JOIN campaigns c ON c.id = cc.campaign_id
              WHERE cc.org_id = ${orgId}::uuid AND c.offer_id = ${o.id}
            ),
            f AS MATERIALIZED (
              SELECT e.id,
                     rc.contact_id IS NOT NULL AS received,
                     coalesce(rc.converted, false) AS converted,
                     ck.contact_id IS NOT NULL AS clicked,
                     NOT EXISTS (SELECT 1 FROM stage_sends s WHERE s.org_id = ${orgId}::uuid AND s.phone = e.phone_number
                                 AND s.contact_id = e.id AND s.status = 'sent' AND s.sent_at > now() - make_interval(days => 0)) AS rested0,
                     NOT EXISTS (SELECT 1 FROM stage_sends s WHERE s.org_id = ${orgId}::uuid AND s.phone = e.phone_number
                                 AND s.contact_id = e.id AND s.status = 'sent' AND s.sent_at > now() - make_interval(days => 7)) AS rested7,
                     NOT EXISTS (SELECT 1 FROM stage_sends s WHERE s.org_id = ${orgId}::uuid AND s.phone = e.phone_number
                                 AND s.contact_id = e.id AND s.status = 'sent' AND s.sent_at > now() - make_interval(days => 30)) AS rested30
              FROM e
              LEFT JOIN rc ON rc.contact_id = e.id
              LEFT JOIN ck ON ck.contact_id = e.id
            )
            SELECT count(*)::int AS eligible,
                   count(*) FILTER (WHERE NOT received)::int AS never_received,
                   count(*) FILTER (WHERE clicked AND NOT converted)::int AS clickers_non_buyers,
                   count(*) FILTER (WHERE NOT received AND rested0)::int AS nr0,
                   count(*) FILTER (WHERE NOT received AND rested7)::int AS nr7,
                   count(*) FILTER (WHERE NOT received AND rested30)::int AS nr30,
                   count(*) FILTER (WHERE received AND NOT clicked AND NOT converted AND rested0)::int AS rt0,
                   count(*) FILTER (WHERE received AND NOT clicked AND NOT converted AND rested7)::int AS rt7,
                   count(*) FILTER (WHERE received AND NOT clicked AND NOT converted AND rested30)::int AS rt30,
                   count(*) FILTER (WHERE clicked AND NOT converted AND rested0)::int AS cb0,
                   count(*) FILTER (WHERE clicked AND NOT converted AND rested7)::int AS cb7,
                   count(*) FILTER (WHERE clicked AND NOT converted AND rested30)::int AS cb30,
                   count(*) FILTER (WHERE NOT rested7)::int AS sent_within_7
            FROM f`)) as unknown as Record<string, number>[];
          if (Number(truth.sent_within_7) > 0) recentSeen = true;
          for (const n of REST_CHECKS) {
            const got = poolCounts(snapshot.base, snapshot.offers[String(o.id)], String(g.id), n);
            const want: PoolCounts = {
              group_total_eligible: Number(truth.eligible),
              never_received: Number(truth.never_received),
              never_received_rested: Number(truth[`nr${n}`]),
              received_not_clicked_rested: Number(truth[`rt${n}`]),
              clickers_non_buyers: Number(truth.clickers_non_buyers),
              clickers_non_buyers_rested: Number(truth[`cb${n}`]),
            };
            check(
              `offer ${o.id} × group "${g.name}" rest_days=${n}: all six counts = the recount`,
              FIELDS.every((f) => got[f] === want[f]),
              { got, want },
            );
          }
        }
      }
      check("control: the recount saw sends inside 7 days (the phone probe works)", recentSeen);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  console.log(failures === 0 ? "\nverify-audience-pools OK." : `\nFAILED: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 7: Run** — `npx tsc --noEmit`; then `npx tsx --conditions=react-server scripts/verify-audience-pools.ts`. Expected: every check ✓, `verify-audience-pools OK.`
- [ ] **Step 8: Commit** (`feat(audience): pool rollup lib + verification`).

### Task 3: Cron + endpoint + route map + HTTP checks

**Files:**
- Create: `app/api/cron/refresh-audience-pools/route.ts`, `app/api/audience/pools/route.ts`
- Modify: `vercel.json`, `lib/authz/route-map.ts`, `scripts/verify-operator-grading-http.ts`

**Interfaces:**
- Consumes: `refreshAudiencePools`, `readAudiencePools`, `REST_DAYS_DEFAULT`, `REST_DAYS_MAX` (Task 2); `withCronLease(jobName, fn, ttlMs)` → `{ ran: true; result } | { ran: false; skippedCount }` (`lib/cron/lease.ts`).

- [ ] **Step 1: Cron route** `app/api/cron/refresh-audience-pools/route.ts`

```ts
import { sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { refreshAudiencePools } from "@/lib/audience/pools";
import { withCronLease } from "@/lib/cron/lease";

// Refreshes the audience_pools rollup (operator_rollups) for every org — the data
// behind GET /api/audience/pools.
//
// ⚠️ READS stage_sends: one org-wide aggregate per org, measured 40.2s on prod
// (2026-09-14, default work_mem). Read-only against the send tables; writes one
// operator_rollups row per org. At :29/:59 it never coincides with
// refresh-fresh-counts (:11/:41) or the */5 jobs.
//
// maxDuration 300 because the cost grows with send volume; the lease TTL sits
// past it so a slow run can never overlap the next tick.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LEASE_MS = 6 * 60 * 1000;

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization") === `Bearer ${secret}`;
  const headerSecret = req.headers.get("x-cron-secret") === secret;
  if (!secret || (!bearer && !headerSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const outcome = await withCronLease(
    "refresh-audience-pools",
    async () => {
      const orgRows = (await db.execute(
        sql`SELECT id AS org_id FROM public.organizations`,
      )) as unknown as { org_id: string }[];
      const results: { org_id: string; duration_ms: number; error?: string }[] = [];
      for (const { org_id } of orgRows) {
        // One org's failure must not stop the rest; its row keeps the previous
        // computed_at and the endpoint reports the staleness.
        try {
          const { durationMs } = await refreshAudiencePools(org_id);
          results.push({ org_id, duration_ms: durationMs });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[audience-pools] refresh failed", { org_id, error: message });
          results.push({ org_id, duration_ms: 0, error: message });
        }
      }
      return results;
    },
    LEASE_MS,
  );
  if (!outcome.ran) {
    // Overlap with a still-running refresh — expected backpressure.
    return NextResponse.json({ ok: true, skipped: true });
  }

  const results = outcome.result;
  return NextResponse.json({
    refreshed: results.filter((r) => !r.error).length,
    failed: results.filter((r) => r.error).length,
    results,
    ts: new Date().toISOString(),
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
```

- [ ] **Step 2: Endpoint** `app/api/audience/pools/route.ts`

```ts
import { NextResponse, type NextRequest } from "next/server";

import { apiError, requireApiMembership } from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { REST_DAYS_DEFAULT, REST_DAYS_MAX } from "@/lib/audience/pool-math";
import { readAudiencePools } from "@/lib/audience/pools";
import { can } from "@/lib/permissions";

// "How many contacts could still be sent offer X?" — per active contact group:
// never received × rested, the re-touch pool, clickers who did not buy.
//
// Counts only: group NAMES and integers. The rollup never holds a contact id or
// a phone number (lib/audience/pools.ts), so there is nothing to strip here.
// Serves a 30-minute rollup and says so: computed_at + stale_seconds on every
// response, 503 rather than zeros before the first run.
export const dynamic = "force-dynamic";

// offers.id is an int4: anything larger would reach Postgres as a 22003.
const MAX_INT4 = 2_147_483_647;

export async function GET(req: NextRequest) {
  const auth = await requireApiMembership({ route: "audience/pools", method: "GET" });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "contacts.stats")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const sp = req.nextUrl.searchParams;
  const offerRaw = sp.get("offer_id");
  const offerId = offerRaw != null && /^\d+$/.test(offerRaw) ? Number(offerRaw) : Number.NaN;
  if (!Number.isInteger(offerId) || offerId <= 0 || offerId > MAX_INT4) {
    return apiError(
      400,
      "offer_id is required and must be a positive whole number",
      API_ERROR_CODES.VALIDATION,
      { field: "offer_id" },
    );
  }
  const restRaw = sp.get("rest_days");
  const restDays =
    restRaw == null ? REST_DAYS_DEFAULT : /^\d+$/.test(restRaw) ? Number(restRaw) : Number.NaN;
  if (!Number.isInteger(restDays) || restDays < 0 || restDays > REST_DAYS_MAX) {
    return apiError(
      400,
      `rest_days must be a whole number from 0 to ${REST_DAYS_MAX}`,
      API_ERROR_CODES.VALIDATION,
      { field: "rest_days" },
    );
  }

  const result = await readAudiencePools(auth.orgId, offerId, restDays);
  switch (result.status) {
    case "ok":
      return NextResponse.json(result.pools);
    case "offer_not_found":
      return apiError(404, "Offer not found", API_ERROR_CODES.NOT_FOUND, { entity: "offer" });
    case "rollup_not_ready":
      return apiError(
        503,
        "Audience pools have not been computed yet. The refresh runs every 30 minutes.",
        API_ERROR_CODES.INTERNAL,
        { reason: "rollup_not_ready" },
      );
    case "offer_not_in_rollup_yet":
      return apiError(
        503,
        "This offer first sent after the last refresh. It appears within 30 minutes.",
        API_ERROR_CODES.INTERNAL,
        { reason: "offer_not_in_rollup_yet" },
      );
  }
}
```

- [ ] **Step 3: `vercel.json`** — after the `refresh-fresh-counts` entry add `{ "path": "/api/cron/refresh-audience-pools", "schedule": "29,59 * * * *" }`.
- [ ] **Step 4: Route map** — in the `// ── audience ──` block add `"audience/pools": { methods: ["GET"], token: ["GET"] },`; before `"cron/refresh-fresh-counts"` add `"cron/refresh-audience-pools": null, // cron / webhook / import machinery -- no operator session reaches these`.
- [ ] **Step 5: HTTP section 11** in `scripts/verify-operator-grading-http.ts`, inserted before `// ---- privacy sweep over every body fetched above ----`:

```ts
  // ---- audience pools ----
  console.log("\n11. /api/audience/pools");
  const [poolOffer] = await db`
    SELECT c.offer_id FROM campaign_stages cs JOIN campaigns c ON c.id = cs.campaign_id
    WHERE cs.org_id = ${orgId} AND cs.sent_at IS NOT NULL AND c.offer_id IS NOT NULL
    GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`;
  const poolsBase = `/api/audience/pools?offer_id=${Number(poolOffer.offer_id)}`;
  const POOL_KEYS = [
    "group_total_eligible", "never_received", "never_received_rested",
    "received_not_clicked_rested", "clickers_non_buyers", "clickers_non_buyers_rested",
  ];
  const pl = await get(poolsBase);
  check("pools: 200", pl.status === 200, { status: pl.status, body: pl.json });
  check("pools: rest_days defaults to 7", pl.json?.rest_days === 7, pl.json?.rest_days);
  const plRows = (pl.json?.data ?? []) as Record<string, unknown>[];
  check(
    "pools rows carry exactly group_name + the six integers",
    plRows.length > 0 &&
      plRows.every(
        (r) =>
          typeof r.group_name === "string" &&
          Object.keys(r).sort().join() === ["group_name", ...POOL_KEYS].sort().join() &&
          POOL_KEYS.every((k) => Number.isInteger(r[k])),
      ),
  );
  check("pools totals carry the six integers", POOL_KEYS.every((k) => Number.isInteger(pl.json?.totals?.[k])));
  check(
    "pools: computed_at string and integer stale_seconds",
    typeof pl.json?.computed_at === "string" && Number.isInteger(pl.json?.stale_seconds),
  );
  const [eligibleLive] = await db`
    SELECT count(*)::int AS n FROM contacts ct
    WHERE ct.org_id = ${orgId} AND ct.is_archived = false
      AND NOT EXISTS (SELECT 1 FROM opt_outs o WHERE o.org_id = ${orgId} AND o.contact_id = ct.id)`;
  check(
    "pools totals: eligible within 1% of a live count (the snapshot is up to 30 min old)",
    Math.abs(Number(pl.json?.totals?.group_total_eligible) - Number(eligibleLive.n)) <= Number(eligibleLive.n) * 0.01,
    { got: pl.json?.totals?.group_total_eligible, live: eligibleLive.n },
  );
  const pl0 = await get(`${poolsBase}&rest_days=0`);
  check(
    "pools rest_days=0: every rested count equals its unrested count",
    ((pl0.json?.data ?? []) as Record<string, number>[]).every(
      (r) => r.never_received_rested === r.never_received && r.clickers_non_buyers_rested === r.clickers_non_buyers,
    ),
  );
  const pl30 = await get(`${poolsBase}&rest_days=30`);
  const at7 = new Map(plRows.map((r) => [r.group_name as string, r as Record<string, number>]));
  check(
    "pools rest_days=30 <= rest_days=7 on every row",
    ((pl30.json?.data ?? []) as Record<string, number | string>[]).every((r) => {
      const s = at7.get(r.group_name as string);
      return (
        s != null &&
        (r.never_received_rested as number) <= s.never_received_rested &&
        (r.received_not_clicked_rested as number) <= s.received_not_clicked_rested &&
        (r.clickers_non_buyers_rested as number) <= s.clickers_non_buyers_rested
      );
    }),
  );
  for (const [name, path, field] of [
    ["missing offer_id", "/api/audience/pools", "offer_id"],
    ["offer_id=abc", "/api/audience/pools?offer_id=abc", "offer_id"],
    ["rest_days=31", `${poolsBase}&rest_days=31`, "rest_days"],
    ["rest_days=-1", `${poolsBase}&rest_days=-1`, "rest_days"],
    ["rest_days=2.5", `${poolsBase}&rest_days=2.5`, "rest_days"],
  ] as const) {
    const r = await get(path);
    check(`pools ${name}: 400 naming ${field}`, r.status === 400 && r.json?.details?.field === field, {
      status: r.status,
      body: r.json,
    });
  }
  const plMissing = await get("/api/audience/pools?offer_id=999999999");
  check("pools for an offer outside the org: 404", plMissing.status === 404, plMissing.status);
  const [neverSent] = await db`
    SELECT o.id FROM offers o
    WHERE o.org_id = ${orgId}
      AND NOT EXISTS (SELECT 1 FROM campaigns c JOIN stage_sends ss ON ss.campaign_id = c.id
                      WHERE c.offer_id = o.id AND ss.status = 'sent')
    LIMIT 1`;
  if (!neverSent) {
    skip("pools for a never-sent offer", "every offer in the org has sent");
  } else {
    const pn = await get(`/api/audience/pools?offer_id=${Number(neverSent.id)}`);
    check(
      "pools for a never-sent offer: 200, never_received = group total, no clickers",
      pn.status === 200 &&
        ((pn.json?.data ?? []) as Record<string, number>[]).every(
          (r) => r.never_received === r.group_total_eligible && r.clickers_non_buyers === 0,
        ),
      { status: pn.status },
    );
  }
```

- [ ] **Step 6: Verify** — `npx tsc --noEmit`; `npx eslint` on every changed file; `npm run check:authz` (expects 39 token routes); start `next dev -p 3107`; trigger the cron once locally (`curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3107/api/cron/refresh-audience-pools`, expected `refreshed ≥ 1, failed 0`); `BASE_URL=http://localhost:3107 npx tsx scripts/verify-operator-grading-http.ts`. Expected: all ✓ including section 11 and the privacy sweep.
- [ ] **Step 7: Commit** (`feat(operator-api): GET /api/audience/pools + 30-min rollup cron`).

### Task 4: Docs, PR, ship

- [ ] `docs/operator-api.md`: failure-table row for the two 503 reasons; §2 new "Pools — who could still get an offer" with a real redacted example, the definitions, the fresh-counts difference (rest from the last sent message of any offer, not campaign creation), overlap note, stale note; §9 line "Pool numbers are counts only — no endpoint reveals which contacts are in a pool."
- [ ] `docs/03-data-model.md`: ERD line `organizations ||--o{ operator_rollups : "operator-API rollups (0178)"` and a table row; last-updated date.
- [ ] `docs/04-features/crons.md`: row for `refresh-audience-pools`; last-updated date.
- [ ] `docs/04-features/operator-api-tokens.md`: token-reachable count and classified-route count from `check:authz`.
- [ ] `docs/07-conventions.md`: bullets — rest from last sent message; bucketed histograms answer any `rest_days`; REPEATABLE READ verification for rollups over live data.
- [ ] `docs/CHANGELOG.md` entry; `npm run check:docs`.
- [ ] PR body: summary, verification counts, migration applied + integrity result, Risk (migration additive; the cron adds ~40s of stage_sends read per 30 min), rollback deployment id. Merge on green; wait for the `Production – camman` deployment; prod smoke (`BASE_URL=https://camman.vercel.app`) after the first prod cron tick.
