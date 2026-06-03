// Pure SMS body composer for a campaign stage. NO React / DB / server imports —
// used by BOTH the stage form's live preview AND the send pipeline so the body
// a recipient receives can NEVER diverge from what the operator previewed.
//
// Shape (short_url/link on its own line between creative text and stop text):
//   <Brand>: <Creative text>
//   <link>            ← omitted entirely when there's no link
//   <Stop text>
//
// `linkUrl` is whichever link applies to the mode: the pasted short_url in
// manual mode, or the minted https://<short_domain>/r/<code> in tracked mode.
// Returns "" when there's no creative (nothing to preview/send yet).

export function buildStageSms(opts: {
  brandName: string;
  creativeText: string | null | undefined;
  linkUrl?: string | null;
  stopText: string;
}): string {
  const { brandName, creativeText, stopText } = opts;
  if (!creativeText) return "";
  const link = (opts.linkUrl ?? "").trim();
  const base = `${brandName}: ${creativeText}`;
  return link.length > 0 ? `${base}\n${link}\n${stopText}` : `${base}\n${stopText}`;
}
