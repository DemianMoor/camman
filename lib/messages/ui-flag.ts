// Message-formats UI flag (hotfix 2026-10-20). PURE and CLIENT-SAFE.
//
// OFF by default: until the owner switches it on, the stage form, the creative
// picker and the drip creative lock behave EXACTLY as before P2 (no format
// select, no custom text, no format warnings, no lock). The backend is NOT
// gated — every stage still carries T1 (0216 trigger / derived-stage copy), every
// send still renders T1 byte-identically and stamps message_format_id.
// P4–P6 UI additions go behind this same flag.
//
// An env var, so it needs no migration. NEXT_PUBLIC_ so client components see
// it; it MUST be read as the literal `process.env.NEXT_PUBLIC_…` below — Next
// only inlines literal references into the browser bundle. Set on Vercel and
// redeploy to switch it on.

export const MESSAGE_FORMATS_UI_ENV = "NEXT_PUBLIC_MESSAGE_FORMATS_UI_ENABLED";

export function messageFormatsUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_MESSAGE_FORMATS_UI_ENABLED === "true";
}

/**
 * The stage create/edit payload's message-shape fields. Flag OFF ⇒ none: the
 * server keeps the stored shape on edit and stamps the org default (T1) on
 * create, so nobody can change a stage's format from the UI.
 */
export function stageFormatPayload(
  values: { message_format_id: number | null; custom_text: string | null },
  uiEnabled: boolean,
): { message_format_id?: number; custom_text?: string } {
  if (!uiEnabled) return {};
  if (values.custom_text != null) return { custom_text: values.custom_text };
  if (values.message_format_id != null) return { message_format_id: values.message_format_id };
  return {};
}
