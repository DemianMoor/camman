import { z } from "zod";

export { nullIfEmpty } from "./_helpers";

// SMS Provider validators. Brands/Networks shape plus two short-link fields.

// A send window is only meaningful when start is earlier than end on the same
// day — the runtime (lib/quiet-hours.ts) silently DISCARDS a window with
// start >= end and falls back to the 08:00–21:00 default, which is a confusing
// footgun (e.g. "09:30–06:30" looks set but does nothing). Reject it at save
// time instead. Only validates a pair when BOTH bounds are present (a partial
// update touching one side is left to the runtime fallback).
function validateWindowOrder(
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
    if (start != null && end != null && start >= end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [`send_window_${label}_end`],
        message: `${label[0].toUpperCase()}${label.slice(1)} end time must be later than the start time.`,
      });
    }
  }
}

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
  // Whether this provider can be sent through via API (TextHub). Toggled in the
  // provider edit UI; a tracked send requires this on + a resolvable credential.
  supports_api_send: z.boolean().optional().default(false),
  // Per-provider auto-send window, minute-of-day in ET (0–1439), per day-type.
  // Null = use the default window (see lib/quiet-hours.ts). The form sends
  // minutes (HH:mm is purely the rendered input), so these pass straight to the
  // integer columns with no per-route conversion.
  send_window_weekday_start: z.number().int().min(0).max(1439).nullable().optional(),
  send_window_weekday_end: z.number().int().min(0).max(1439).nullable().optional(),
  send_window_weekend_start: z.number().int().min(0).max(1439).nullable().optional(),
  send_window_weekend_end: z.number().int().min(0).max(1439).nullable().optional(),
  // Circuit-breaker caps. Null = the built-in default (1000 / 100 / 10000). The
  // per-run pacing cap maxes at 2000 (ABSOLUTE_MAX_SENDS_PER_RUN — larger values
  // are clamped in code anyway). send_paused is NOT settable here — it's managed
  // via the dedicated pause/resume endpoint (audited).
  max_sends_per_run: z.number().int().min(1).max(2000).nullable().optional(),
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

export const providerCreateSchema = providerBaseSchema.superRefine(validateWindowOrder);

export const providerUpdateSchema = providerBaseSchema
  .partial()
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one field must be provided",
  })
  .superRefine(validateWindowOrder);

export type ProviderCreateInput = z.infer<typeof providerCreateSchema>;
export type ProviderUpdateInput = z.infer<typeof providerUpdateSchema>;
export type ProviderFormValues = z.input<typeof providerCreateSchema>;

// Set/rotate a provider's API key. brand_id null = the provider-wide default
// key; a positive id scopes the key to that brand. The key itself is never
// echoed back to the client (responses are masked).
export const providerCredentialSetSchema = z.object({
  brand_id: z.number().int().positive().nullable().optional().default(null),
  api_key: z.string().trim().min(1, "API key is required").max(500),
});

export type ProviderCredentialSetInput = z.infer<
  typeof providerCredentialSetSchema
>;

// Send a one-off test SMS using a specific stored credential. The key is
// resolved server-side from credential_id (never sent by the client). number
// is validated/normalized to E.164 in the route.
export const providerCredentialTestSchema = z.object({
  credential_id: z.number().int().positive(),
  number: z.string().trim().min(1, "Recipient number is required").max(40),
  text: z.string().trim().min(1, "Message text is required").max(1000),
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
