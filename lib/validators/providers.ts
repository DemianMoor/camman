import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

// SMS Provider validators. Brands/Networks shape plus two short-link fields.

// ⚠️ A send window is only honoured when `start < end`. `effectiveWindow`
// (lib/quiet-hours.ts) treats anything else — equal bounds, inverted bounds —
// as UNSET and silently falls back to the DEFAULT 08:00–21:00 ET window. So
// `0/0` does not mean "never send"; it means "send during the default hours",
// the exact opposite of what an operator typing it intends.
//
// These columns cannot express "never send" at all. Disabling a provider is
// `send_paused` (the audited latch), which is what this error points at.
//
// Applied to BOTH create and update via the shared base below, because a PATCH
// can set the pair just as easily as a POST.
function checkSendWindows(
  data: {
    send_window_weekday_start?: number | null;
    send_window_weekday_end?: number | null;
    send_window_weekend_start?: number | null;
    send_window_weekend_end?: number | null;
  },
  ctx: z.RefinementCtx,
) {
  const pairs = [
    ["weekday", data.send_window_weekday_start, data.send_window_weekday_end],
    ["weekend", data.send_window_weekend_start, data.send_window_weekend_end],
  ] as const;
  for (const [label, start, end] of pairs) {
    if (start == null || end == null) continue; // null pair = "use the default", legitimate
    if (start < end) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [`send_window_${label}_start`],
      message:
        start === end
          ? `The ${label} sending window start and end are the same, which does not disable sending — ` +
            `it falls back to the default 08:00–21:00 ET window. To stop this provider sending, ` +
            `pause it instead (Pause sending on the provider page).`
          : `The ${label} sending window ends before it starts, which falls back to the default ` +
            `08:00–21:00 ET window. Set start earlier than end, or pause the provider to stop sending.`,
    });
  }
}

// Base object. Kept as a plain ZodObject so `.partial()` still works below —
// attaching the refinement here would make it a ZodEffects and break that.
const providerBaseSchema = z.object({
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

// Create adds the connection-type picker fields (869egmakh P3) on top of the
// shared base.
//
// Two ways to create a provider row, and the difference is deliberate:
//
//   1. PICK A TYPE (`connection_type` set). The provider code is DERIVED from
//      the adapter registry, never typed — that is what kills the
//      `texthub`-vs-`txh` footgun, where a mistyped code produced a row that
//      passed every check and then threw UnknownProviderError at drain time,
//      after activation.
//
//   2. CUSTOM (`connection_type` omitted). A row with no API adapter, for
//      providers sent through manually (snx, smpl). `sms_provider_id` is typed
//      by the operator because there is no registry entry to derive it from.
//
// ⚠️ `create_separate_row` is the anti-drift control. Picking a type that
// already has a provider row is REFUSED by default, with a pointer at the
// existing row, because the right way to add a second account is a new
// CREDENTIAL on that row — not a second provider. Creating a genuinely separate
// row stays possible (txh2 is a real, legitimate instance) but must be
// deliberate: this flag ON *and* an explicit distinct `sms_provider_id`. The
// server never auto-suffixes a code; silent auto-suffixing by the UI is exactly
// how txh2 came to exist.
export const providerCreateSchema = providerBaseSchema
  .extend({
    // Canonical connection-type key from GET /api/provider-types.
    connection_type: z.string().trim().min(1).max(40).optional(),
    // Opt-in to a second provider row of a type that already exists.
    create_separate_row: z.boolean().optional().default(false),
    // Derived server-side when a type is picked without create_separate_row,
    // so the client's value is ignored there rather than trusted.
    sms_provider_id: providerBaseSchema.shape.sms_provider_id.optional(),
  })
  .superRefine(checkSendWindows)
  .superRefine((data, ctx) => {
    // Custom mode must name its own code — nothing to derive it from.
    if (!data.connection_type && !data.sms_provider_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sms_provider_id"],
        message: "Pick a connection type, or enter a provider ID for a custom provider.",
      });
    }
    // A deliberate second row of an existing type must carry its own distinct
    // code. Without this the request is ambiguous and the server would have to
    // invent one — the exact behaviour this design forbids.
    if (data.create_separate_row && !data.sms_provider_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sms_provider_id"],
        message:
          "A separate provider row of an existing type needs its own distinct provider ID.",
      });
    }
    // Contradictory mode fields are REJECTED, never silently resolved.
    //
    // Both cases below used to fall through and quietly ignore one of the
    // supplied fields, which is the same class of failure as auto-suffixing: the
    // request said one thing, the row became another, and nothing told anyone.
    // A caller who sends contradictory fields has a bug; answering 400 surfaces
    // it instead of writing a row they didn't ask for.

    // (a) A derived code cannot also be dictated. With a type picked and no
    //     separate-row opt-in, the code comes from the registry — accepting a
    //     typed value here would let a caller believe they chose the code.
    if (data.connection_type && !data.create_separate_row && data.sms_provider_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sms_provider_id"],
        message:
          "The provider ID is set by the connection type. Remove it, or choose to create a separate provider row.",
      });
    }
    // (c) A separate row is a variant of an EXISTING type, so it is meaningless
    //     without one. Silently treating it as a custom provider would ignore
    //     the operator's stated intent.
    if (data.create_separate_row && !data.connection_type) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["create_separate_row"],
        message:
          "A separate provider row only applies to a chosen connection type.",
      });
    }
  });

export const providerUpdateSchema = providerBaseSchema
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
  .superRefine(checkSendWindows)
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
