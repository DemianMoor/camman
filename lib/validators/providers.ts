import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

// SMS Provider validators. Brands/Networks shape plus two short-link fields.

export const providerCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  sms_provider_id: z
    .string()
    .trim()
    .min(1, "sms_provider_id is required")
    .max(40)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "sms_provider_id may only contain letters, digits, hyphens, and underscores",
    ),
  short_link_supported: z.boolean().optional().default(false),
  short_link_example: z.string().trim().max(200).optional(),
  // `supports_api_send` is NOT settable here — it's the go-live gate, managed
  // via the dedicated POST /api/providers/[providerId]/api-send endpoint
  // (audited into send_circuit_events). Same carve-out as `send_paused` below,
  // and for a stronger reason: send_paused fails SAFE (stops sending) while
  // this fails OPEN.
  //
  // It used to live on this schema and in the bulk provider form, which submits
  // the whole object on every save with no concurrency check — so a page loaded
  // while the flag was true and saved after it was set false wrote `true` back.
  // Observed on the `tls` provider 2026-08-13 (ClickUp 869ehjwtf). A new
  // provider is always created with the flag OFF; turning it on is a deliberate,
  // attributable act.
  // Per-provider auto-send window, minute-of-day in ET (0–1439), per day-type.
  // Null = use the default window (see lib/quiet-hours.ts). The form sends
  // minutes (HH:mm is purely the rendered input), so these pass straight to the
  // integer columns with no per-route conversion.
  send_window_weekday_start: z.number().int().min(0).max(1439).nullable().optional(),
  send_window_weekday_end: z.number().int().min(0).max(1439).nullable().optional(),
  send_window_weekend_start: z.number().int().min(0).max(1439).nullable().optional(),
  send_window_weekend_end: z.number().int().min(0).max(1439).nullable().optional(),
  // Circuit-breaker caps. Null = the built-in default (1000 / 100 / 10000). The
  // per-run pacing cap maxes at 20000 (ABSOLUTE_MAX_SENDS_PER_RUN — larger values
  // are clamped in code anyway). send_paused is NOT settable here — it's managed
  // via the dedicated pause/resume endpoint (audited).
  max_sends_per_run: z.number().int().min(1).max(20_000).nullable().optional(),
  max_sends_per_minute: z.number().int().min(1).max(100_000).nullable().optional(),
  max_sends_per_24h: z.number().int().min(1).max(10_000_000).nullable().optional(),
  avatar_url: z
    .union([z.string().url("avatar_url must be a valid URL"), z.literal("")])
    .optional(),
  color: z
    .union([
      z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/, "color must be a 6-char hex like #1A2B3C"),
      z.literal(""),
    ])
    .optional(),
});

export const providerUpdateSchema = providerCreateSchema
  .partial()
  .extend({
    // ⚠️ `.partial()` does NOT strip an inner `.default()`. Verified against the
    // Zod version in this repo: parsing `{ name: "x" }` against the partial
    // schema yields `short_link_supported: false` — a REAL value, not
    // `undefined` — so the PATCH route's `if (v === undefined) continue` guard
    // does not skip it and the route WRITES false. Any partial PATCH that
    // omitted this field silently cleared it.
    //
    // Re-declared here without the default so "omitted" means "leave
    // unchanged", which is what a PATCH must mean. Pinned by
    // scripts/test-provider-update-schema.ts — if a Zod upgrade changes
    // `.partial()`/`.default()` composition, that test fails rather than a
    // provider silently losing a flag.
    short_link_supported: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

// The `supports_api_send` go-live gate. Its own endpoint, its own audit row.
// `reason` is free text for the audit trail (why it was turned on/off).
export const providerApiSendSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().max(200).optional(),
});

export type ProviderApiSendInput = z.infer<typeof providerApiSendSchema>;

export type ProviderCreateInput = z.infer<typeof providerCreateSchema>;
export type ProviderUpdateInput = z.infer<typeof providerUpdateSchema>;
export type ProviderFormValues = z.input<typeof providerCreateSchema>;

// Set/rotate a provider's API key. brand_id null = the provider-wide default
// key; a positive id scopes the key to that brand. The key itself is never
// echoed back to the client (responses are masked).
export const providerCredentialSetSchema = z.object({
  brand_id: z.number().int().positive().nullable().optional().default(null),
  api_key: z.string().trim().min(1, "API key is required").max(500),
  // Required (Phase 3): POST is create-only now, one row per account, and the
  // multi-account UI always sends an operator-facing label to distinguish
  // rows on the same provider. No more derived-default fallback.
  label: z.string().trim().min(1, "Label is required").max(120),
});

export type ProviderCredentialSetInput = z.infer<
  typeof providerCredentialSetSchema
>;

// Update an existing credential (account): label, brand scoping, its linked
// numbers, and/or rotate the key. `phone_ids`, when present, is the COMPLETE
// set of provider_phones ids that should belong to this credential — the
// route links those and unlinks any of this credential's phones not in the
// set (see lib/providers/credential-phone-links.ts). `api_key`, when
// present, rotates the stored secret (re-encrypted server-side; never
// echoed back).
export const providerCredentialUpdateSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    brand_id: z.number().int().positive().nullable().optional(),
    api_key: z.string().trim().min(1).max(500).optional(),
    phone_ids: z.array(z.number().int().positive()).max(200).optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  });

export type ProviderCredentialUpdateInput = z.infer<
  typeof providerCredentialUpdateSchema
>;

// Send a one-off test SMS using a specific stored credential. The key is
// resolved server-side from credential_id (never sent by the client). number
// is validated/normalized to E.164 in the route.
export const providerCredentialTestSchema = z.object({
  credential_id: z.number().int().positive(),
  number: z.string().trim().min(1, "Recipient number is required").max(40),
  text: z.string().trim().min(1, "Message text is required").max(1000),
  // Optional send-from number (must be a phone linked to this account). Null /
  // omitted → send with no `sender`, letting TextHub use the account default.
  provider_phone_id: z.number().int().positive().nullable().optional(),
});

export type ProviderCredentialTestInput = z.infer<
  typeof providerCredentialTestSchema
>;

// Register the inbound opt-out (STOP) callback for a stored credential with
// TextHub. Body is optional; keywords default to ["STOP"] in the route. The
// api_key is resolved server-side from the credential — never sent by the
// client.
export const registerOptOutCallbackSchema = z.object({
  keywords: z
    .array(z.string().trim().min(1).max(40))
    .max(20)
    .optional(),
});

export type RegisterOptOutCallbackInput = z.infer<
  typeof registerOptOutCallbackSchema
>;
