// Pure SMS body composer for a campaign stage. NO React / DB / server imports —
// used by BOTH the stage form's live preview AND the send pipeline so the body
// a recipient receives can NEVER diverge from what the operator previewed.
//
// This is T1 of lib/messages/format.ts — the pre-format shape, byte-for-byte:
//   <Brand>: <Creative text>
//   <link>            ← omitted entirely when there's no link
//   <Stop text>       ← omitted entirely when the resolved footer is empty
//
// `linkUrl` is whichever link applies to the mode: the pasted short_url in
// manual mode, or the minted https://<short_domain>/r/<code> in tracked mode.
// `stopText` is the RESOLVED opt-out footer (lib/sends/opt-out-footer.ts), not
// necessarily the stage's stop_text. An empty footer arises only when the
// provider appends its own opt-out text (descriptor.appendsOwnOptOut); its line
// is dropped rather than left as a trailing newline.
// Returns "" when there's no creative (nothing to preview/send yet).
//
// Callers move to lib/messages/render.ts renderMessage as stages gain formats.

import { T1_TEMPLATE, assembleMessage } from "@/lib/messages/format";

export function buildStageSms(opts: {
  brandName: string;
  creativeText: string | null | undefined;
  linkUrl?: string | null;
  stopText: string;
}): string {
  return assembleMessage(T1_TEMPLATE, {
    brand: opts.brandName,
    creative_text: opts.creativeText ?? "",
    url: opts.linkUrl ?? "",
    stop_text: opts.stopText ?? "",
  });
}
