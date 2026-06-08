# Docs Changelog

A running log of documentation-affecting changes. Add a dated entry whenever a doc is materially updated, and note the code commit/migration that prompted it.

## 2026-06-08 — Upload contacts onto a draft campaign
- New `POST /api/campaigns/[campaignId]/upload-contacts` + draft-only "Upload contacts" button on the campaign detail page: CSV/paste phone upload that upserts contacts, tags them into selected existing contact group(s), and UNIONs those groups into the campaign's `audience_contact_group_ids`. Draft-only (audience freezes at activation); requires `contacts.upload` + `campaigns.update`. — Docs updated: [04-features/campaigns-stages-creatives.md](04-features/campaigns-stages-creatives.md).

## 2026-06-05 — Initial documentation set
- Created the full `docs/` set: `README`, `01-overview`, `02-architecture`, `03-data-model` (with ER diagram), `04-features/*` (12 module files), `05-flows`, `06-integrations`, `07-conventions`, `08-local-setup`.
- Documented reality against the codebase at branch `main` (recent commits through `bf7010a` "Active stages block"; schema through migration `0058_send_circuit_breakers`).
- Recorded 5 doc↔code discrepancies and a set of `[VERIFY]` items in [07-conventions.md](07-conventions.md):
  1. Activation gate requires ≥1 **contact group** (not segment) — code vs CLAUDE.md §10b.
  2. `is_in_contact_group` rule type present in eval/migration `0031` but missing from the inline CHECK list in `db/schema.ts`.
  3. `.env.example` shows pooler port `5432`; CLAUDE.md §6 mandates `6543` (transaction pooler).
  4. No command palette / cmdk exists (was on the wishlist).
  5. `proxy.ts` protected-prefix list is narrower than the full protected route set.
- Pre-existing `docs/security-notes.md` left untouched; linked from the index.

> When you change behavior that a doc describes, update the doc **and** add an entry here in the same PR (Part B rule).
