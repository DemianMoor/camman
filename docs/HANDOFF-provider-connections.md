# Handoff — provider connections, per-number settings, brand domains

_Written 2026-08-17. Assumes zero context. Everything needed to continue is here._

This covers three ClickUp cards' worth of work, most of it shipped. Read the **State** table first, then the phase you are picking up.

---

## 1. State — what is shipped

All merged to `main` and live in production unless marked otherwise.

| # | PR | What | Merge sha | Prod deployment |
|---|----|------|-----------|-----------------|
| P1 | #69 | Adapter descriptors + `GET /api/provider-types` | `81d4824` | `5942408412` |
| — | #70 | Date-stamp corrections | `3364db5` | — |
| P2 | #71 | Uniform Test-connection + server-side action gates | `dd19110` | `5944841598` |
| P3 | #72 | Connection-type picker + collision handling | `a4e66e1` | `5943560283` |
| R0 | #75 | STOP intake un-coupled from sending capability | `1a6e51a` | `5945439397` |
| — | #76 | `adapter_code` on create + `tls-t` backfill | `bb9ecb6` | `5945753695` |
| Q0 | #77 | Brand may have >1 short domain | `92a3fc5` | `5947998748` |
| A3 | #79 | `txh2` alias retired, COALESCE fallbacks removed | `b32e64f` | `5948625255` |
| Q1 | #80 | Per-phone short domain override | `2a61ac5` | `5949939587` |
| Q2 | _this PR_ | Descriptor-driven per-number settings | — | — |

### Migrations applied (all verified with `scripts/verify-migration-integrity.ts`)

| # | What |
|---|------|
| 0134 | `sms_providers.adapter_code` + backfill (`txh`/`txh2`→`txh`, `snx`/`smpl`→NULL) |
| 0135 | Backfill `tls-t` → `adapter_code='tls'`; ends with a guard that RAISEs if any `supports_api_send` row lacks a resolvable `adapter_code` |
| 0136 | Dropped `short_domains_brand_id_uniq`; plain index replaces it |
| 0137 | `provider_phones.short_domain_id` FK, `ON DELETE SET NULL` |

**Next free migration number: 0138.** Journal has 138 entries ending `0137_…`. Snapshots here are **partial** — several tables are absent from them entirely — so a new snapshot is normally a clone-forward with new `id`/`prevId`. `verify-migration-integrity` checks file hashes and the prevId chain, *not* schema fidelity.

### Provider rows in production (8)

| id | `sms_provider_id` | `adapter_code` | api_send | note |
|----|-------------------|----------------|----------|------|
| 1 | `snx` | NULL | false | archived, custom/no-API |
| 2 | `txh` | `txh` | true | TextHub |
| 96 | `smpl` | NULL | false | custom/no-API |
| 314 | `ahi` | `ahi` | true | Ahoi |
| 499 | `txh2` | **`txh`** | true | second TextHub account — identity ≠ type |
| 641 | `txr` | `txr` | true | Text Request |
| 855 | `tls` | `tls` | true | Tells |
| 948 | `tls-t` | **`tls`** | false | second Tells account, inert |

### Not started

**R1, R2, R3, R4, B1, B2.**

---

## 2. Standing decisions — do not re-litigate

### `adapter_code` vs `sms_provider_id`

- `adapter_code` = the **connection TYPE**. What `getAdapter()` resolves. Read it for "what kind of provider is this".
- `sms_provider_id` = the **row IDENTITY**. Read it for "which account is this".
- Circuit breakers, send windows, per-provider reporting and cost attribution are **per-ACCOUNT** and must stay on identity. Pointing any at `adapter_code` silently merges `txh` and `txh2`'s counters.
- NULL `adapter_code` = no adapter (custom/manual provider). A real state, not missing data.
- **The `txh2` registry alias is retired.** `getAdapter("txh2")` must throw. If it ever resolves again, an alias has crept back.

### Part B of card 869ej8qzk — REJECTED, permanently

Collapsing the `txh2` row into `txh` is **not happening**. Measured cost: 412 campaign stages (34 on active campaigns), 1.38M `stage_sends` rows, and it would merge two accounts' circuit-breaker counters. After `adapter_code`, `txh2` is a legitimate multi-account row under the migration-0110 model.

If the two TextHub accounts turn out to share carrier-side limits upstream, that is a **metering-configuration** question, never a row collapse.

### R1 — `sends_enabled` + `opt_out_footer` (migration, pre-approved)

```sql
ALTER TABLE sms_providers
  ADD COLUMN IF NOT EXISTS sends_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS opt_out_footer text;
```

- `NOT NULL DEFAULT true` ⇒ every existing row keeps today's behaviour.
- **Do NOT touch `send_paused` semantics.** It is the auto-tripped emergency latch; `sends_enabled` is deliberate operator posture. Keeping them separate is the whole point — otherwise a breaker trip and a human decision become indistinguishable in the audit trail.
- **Do NOT fix the kickoff/`send_paused` asymmetry** (kickoff checks `supports_api_send` but not `send_paused`; only drain and scheduled check the latch). It is pre-existing. Note it as a follow-up card candidate; tonight's scope stays byte-identical.
- `opt_out_footer` ships **NULL on every row**.

### R2 — enforcement, both directions proven

- New kickoff refusal key; drain skip; `scheduled.ts` filters (two phases, lines ~106 and ~172 carry the `send_paused` predicates — mirror them); surface in `preflight.ts` and `send-state.ts`.
- **Proof 1:** provider off ⇒ no new sends.
- **Proof 2:** provider off ⇒ **STOP intake unchanged**. Extend `scripts/test-stop-intake-ungated.ts` to flip the new flag too.
- **All 7 (now 8) rows must end the phase with `sends_enabled = true` and behaviour byte-identical.**

### R3 — descriptor `notes: string[]`, seed content

Code-owned, rendered in the panel:

- **TextHub** — unreliable HTTP codes (a failure envelope can arrive as 404; classify off body `status`); fabricated short-code DLRs.
- **Tells** — cannot verify a key without sending (its only endpoint sends); webhook-only intake; **its inbound webhook body carries the LIVE API key in `Key`** and is redacted before persist.
- **Text Request** — portal-vs-API footer difference.
- **Per-provider MPS / limits** — per-second rate lives on `provider_phones.max_sends_per_second`, not the provider row.

### R4 — `/settings/providers`

Sections over the provider row so per-provider limits and country restrictions slot in later without a redesign. Toggle · editable STOP text · capability badges · accounts + numbers counts · "About this provider" from `notes`.

**Provider STOP-text values ship EMPTY.** The chain must fall through to `stage.stop_text`, byte-identical. Populating them is a per-provider compliance decision the operator makes later.

### Q3 amendment (for whenever Q3 runs — NOT tonight's scope)

Per-provider STOP text is a **DB column on the provider row**, operator-editable. The descriptor's `defaultOptOutFooter` demotes to a seed/suggestion shown in the UI.

**New precedence:** `number.opt_out_footer` > **`provider.opt_out_footer` (DB)** > `stage.stop_text` > `'Stop to END'`. `appendsOwnOptOut` unchanged. Card 869ej8r1y must be updated before Q3 builds.

### B1 — brand domains

- Insert `g.guidekn.com`, `g.lumzen.co`, `g.fitsyou.net` as **`status='pending'`**. **Do NOT activate them** — activation plus a first tracked campaign per brand is the operator's hands-on acceptance.
- Activation gated on a **live probe** through the domain hitting the app.
- **Exactly one default per brand, DB-enforced** (partial unique index or FK — implementer's choice, but enforced in the database).
- **Resolution order:** `phone.short_domain_id` > brand default > current oldest-active pick.
- Kickoff already selects `status='active'` only, so pending rows are excluded by a clause that exists today.

**⚠️ Brand 142 has no active short domain at all.** Only brand 8 (`gdkn.org`) does. A tracked campaign on the other brands refuses today with `no_short_domain`. Activating `g.lumzen.co` / `g.fitsyou.net` therefore **enables tracked sending for those brands for the first time** — acceptance needs one tracked campaign per newly-activated brand, not just the domain probe.

---

## 3. B2 warm-start notes

**B2 is the highest-risk remaining phase. Its regression bar is a hard stop, not a judgement call. Run it with the operator present.**

### Current link-length assumption — as found

`buildStageSms()` (`lib/sends/stage-sms.ts`) composes:

```
<Brand>: <creative text>
<link>
<stop text>
```

It takes `linkUrl` as an **already-built string**. The stage form builds a *representative* link for preview; kickoff builds the real one from the minted code. Both feed `countSegments()` → `calculateSmsSegments()` (`lib/creative-helpers.ts`).

**So length is computed from an actual URL string, not a fixed constant.** The risk is not a hardcoded number — it is that **preview and kickoff construct that string differently** once the domain is resolved per-phone. B2's job is to make the resolved domain feed a single source of truth used by both.

### The 8-vs-13-character trap

`gdkn.org` is **8** characters. `g.guidekn.com` is **13**. Any length computed *before* domain resolution is wrong for the new hosts by up to **5 characters** — enough to cross a 160-character GSM-7 segment boundary and silently add a segment (and its cost) at send time while the preview still shows one.

### Regression corpus

`stage_sends.rendered_text` for stages sent since the `adapter_code` cutover (`2026-08-17T12:21:28Z`):

- `txh` — 4,631 rows
- `txh2` — 40,120 rows

These are **real rendered bodies** under `gdkn.org`. `campaign_stages.tracking_id` and the stage's `stop_text` are recoverable for re-derivation. Large, real, single-domain — exactly what "byte-identical on today's setup" requires.

### The bar

With `gdkn.org` as the only active domain, **every estimate and every rendered body must match current behaviour exactly**. Any mismatch is a hard stop.

---

## 4. Conventions learned tonight

All are in `docs/07-conventions.md`. Summarised because they were expensive:

1. **`git -C <absolute path>` for every git command.** The agent shell's cwd is not reliably persistent between tool calls; a relative `cd … && git …` can execute against the shared checkout. A `git branch -m` did exactly that and renamed another session's branch.
2. **Never `git add -A`.** It swept an uncommitted migration from another branch into an unrelated PR — a migration file with no journal entry, which `db:migrate` skips and `verify-migration-integrity` flags. Stage explicit paths.
3. **Cleanup must ASSERT, not hope.** Teardown runs after `ALL PASS` has printed, which is when nobody reads. `DELETE … WHERE id = ANY(${jsArray})` throws under postgres-js and the delete silently never runs — a probe row survived in production. Delete with scalar binds, then re-query and fail if anything is left.
4. **Probes that WRITE run against the `camman-v2` demo database.** Even a self-cleaning probe row is a production data write and needs approval.
5. **An unexplained detail in a PASSING run is a finding.** A count reading 3 where the code said 2 led to the discovery that `POST /api/providers` never wrote `adapter_code` — every provider created through the picker was unsendable. No assertion caught it; the number was printed as context.
6. **Verification tooling gets guard-grade treatment.** Print input scope, assert non-empty, fail loudly on a missing binary or empty variable. Five checkers misreported tonight: a `|| echo '[]'` that swallowed every poll (`gh pr checks` exits non-zero while pending); a success test matching `api.github.com` inside an *error* URL; a loop piping to an uninstalled `jq`; an empty `FILES` that made eslint scan the whole repo; and an assertion comparing a value to itself.
7. **STOP intake is never gated on a sending flag.** No intake path may reference `supports_api_send`, `send_paused`, `sends_enabled`, `sends_paused`. Provider *type* is fine; provider *posture* is not.
8. **A credential check has three outcomes.** `valid` / `invalid` / **`unknown`** — never collapse `unknown` into pass or fail. Ahoi and Tells both answer HTTP 200 on auth failure, so the checker parses an undocumented envelope; if it changes, degrade to "couldn't verify", never a false green.
9. **Dates come from the current date, never from data timestamps.** A whole workstream shipped stamped three days stale because it anchored on the newest rows in the data being queried.
10. **Read the output, not the exit code.** `gh pr merge` reported an error while the merge had landed (only the branch-delete 503'd); `git add` failed and the following `git commit` still produced a commit containing only a file deletion.
11. **Retire obsolete assertions rather than bending data to them.** `verify-adapter-code.ts` asserted both columns resolve identically — correct during the cutover, wrong afterwards, because the whole point is that they may differ. Its txh2 assertion is now **inverted**: the bare identity string must NOT resolve.

### Environment notes

- **`jq` is not installed.** Use `gh --jq`.
- Worktrees have no `node_modules` and no `.env.local` — junction and hard-link them. Unlink the junction with `cmd //c rmdir`, **never** `rm -rf`.
- Local `main` runs far behind; always branch from `origin/main` after a successful `git fetch`. A failed fetch leaves a stale ref that looks fine.
- GitHub had a **major outage** during this session (Pull Requests / API / Actions / Webhooks). PR creation took six attempts. Check `githubstatus.com` before diagnosing CI as broken.

---

## 5. Pending ClickUp mirrors

The ClickUp MCP was disconnected for this entire session. **Nothing below has been mirrored.**

| Card | Action |
|------|--------|
| 869egmakh | **Close** — P1, P2, P3 all shipped |
| 869egmakh | P3 scope change: "Test before saving" on the create form was deliberately NOT built; provider creation and credential creation stay separate |
| 869ej8qzk | Part A complete (all 3 steps: migration, switch, alias removal). **Part B remains rejected** |
| 869ej8qzk | Correct the stale migration facts — it says "next is 0125, queues behind pending 0121–0124"; both wrong |
| _new card_ | R0 shipped — STOP intake un-coupled from sending capability |
| _new card_ | `adapter_code` on create + migration 0135 `tls-t` backfill |
| 869ej8r00 | Q0, Q1, Q2 shipped |
| _new card_ | Provider-connections admin panel (R1–R4) — drafted, not created |
| _new card_ | B-series brand domains (B0–B2) — drafted, not created; **include the brand-142 note** |
| 869ej8r1y | Q3 amendment: per-provider STOP text is a DB column; new precedence chain |
