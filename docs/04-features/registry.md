# Feature — Registry (brands, offers, networks, providers, …)

_Last updated: 2026-07-22_

## 1. Purpose
The registry is the set of lookup/reference entities a campaign is composed from: who the campaign is for (brand/offer/network), how it's sent (provider/phone), and how it's classified (routing type, traffic type, UTM tags). They share one CRUD pattern, cloned from the original **Brands** implementation (CLAUDE.md §11).

## 2. Entities
| Entity | Table | Notable fields | Availability flag |
|--------|-------|----------------|-------------------|
| Brands | `brands` | `brand_id` (text uniq), `website`, `color`, `avatar_url` | `brands` |
| Offers | `offers` | `offer_id`, `network_id` (NOT NULL, restrict), `payout_model` cpa/revshare, `payout_cpa` (**current-rate cache only** — not used for historical revenue), `payout_revshare`, `sales_pages[]` | `offers` |
| Affiliate networks | `affiliate_networks` | `network_id`, `url` | `networks` |
| SMS providers | `sms_providers` | `supports_api_send`, send-window cols, circuit-breaker cols | `providers` |
| Provider phones | `provider_phones` | `provider_id`, `brand_id`, `phone_number`, `number_type` (10dlc/toll_free/short_code), `cost_per_sms` | (under providers) |
| Routing types | `routing_types` | `routing_type_id`, `name` | `routing_types` |
| Traffic types | `traffic_types` | `traffic_type_id`, `name` | `traffic_types` |
| UTM tags | `utm_tags` | `tag_id`, `label`, `value_source`, `affiliate_network_id` | `utm_tags` |

## 3. How it works
- Standard REST per entity (CLAUDE.md §8): `GET /api/[entity]/list`, `POST /api/[entity]`, `GET/PATCH /api/[entity]/[id]`, `POST …/archive`, `…/restore`. Parent/child entities use `[parentEntityId]` segments (e.g. `/api/providers/[providerId]/phones/...`).
- List params: `page`, `pageSize`, `search`, `showArchived`, `sortBy`, `sortDir`. Response: `{ data, totalCount, page, pageSize }`.
- All inputs Zod-validated (`lib/validators/`), outputs typed, errors `{ error, code? }`.
- **Availability gating:** [`lib/feature-flags.ts`](../../lib/feature-flags.ts) `ENTITY_AVAILABILITY` is the single source of truth for "is this entity built?". It drives the sidebar nav and any cross-entity FK picker's disabled state via `isEntityAvailable()`. All registry flags are currently `true`.

## 4. Data it reads/writes
- Each entity owns its table. Cross-references: `offers.network_id → affiliate_networks` (restrict), `provider_phones.provider_id → sms_providers`, `utm_tags.affiliate_network_id → affiliate_networks` (set null).
- Deleting a referenced brand/offer is blocked by **`ON DELETE RESTRICT`** when a campaign points at it; archive instead.
- **Offer CPA history (`offer_payouts`, migration 0083):** the offers create/update path writes an effective-dated CPA trail. Creating a CPA offer opens the first row (`effective_from = created_at`, `effective_to = NULL`); a later CPA change closes the open row (`effective_to = now()`) and opens a new one instead of overwriting. `offers.payout_cpa` is kept in sync as the current-rate cache. A partial unique index allows at most one open row per offer. This is for display/audit only — **revenue is always sourced from `keitaro_stage_results.revenue`** (see [conventions §Money](../07-conventions.md)), never recomputed from a CPA.

## 5. UI surface
- One page per entity under [`app/(protected)/`](../../app/(protected)/) (e.g. `brands/`, `offers/`, `affiliate-networks/`, `providers/`, `routing-types/`, `traffic-types/`, `utm-tags/`).
- List views use the `DataTable` wrapper; filters persisted to localStorage via `usePersistedFilters`.
- Create/edit dialogs use the shared `<FormDialog>` (blocks accidental dismissal).

## 6. Rules & edge cases
- `offers.network_id` is **required** (migration `0032`) — an offer must belong to a network.
- `provider_phones`: `short_code` numbers leave geo columns NULL; `10dlc`/`toll_free` are E.164.
- **Move a number to another provider.** The Edit-phone dialog has a **Provider** picker; changing it reassigns `provider_phones.provider_id` **in place** (same row, so the `(org_id, phone_number)` unique constraint is never re-triggered — this is how you shift a number between vendors without the "already exists" error). Handled by `PATCH /api/providers/[providerId]/phones/[phoneId]` with a `provider_id` (target) field. The move also **clears `credential_id`** (the account link belonged to the old provider) and, because number-level reports resolve a send's provider from the phone's current `provider_id`, **re-attributes the number's past sends to the new provider** in those reports. If not-yet-sent stages (`status IN ('draft','pending')`) reference the number, the API returns `409` with `details.reason = 'move_needs_confirmation'` (+ the affected stages); the UI shows a confirm dialog and the client re-submits with `confirm_move: true`. Permission: `provider_phones.update` (operator+). No schema change — the column and all `provider_phones.id` FKs (`ON DELETE SET NULL`) already support it.
- Provider circuit-breaker + send-window columns live on `sms_providers` but are consumed by the [send pipeline](sms-send-pipeline.md), not the registry CRUD.

## 7. Extension points / limitations
- New registry entity: copy the Brands implementation, add the table + migration, build API + UI, **then** flip its `ENTITY_AVAILABILITY` flag last (CLAUDE.md §7). Before flipping, confirm no other entity's form silently starts fetching it.
