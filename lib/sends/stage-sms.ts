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
  // `stopText` is the RESOLVED opt-out footer (lib/sends/opt-out-footer.ts),
  // not necessarily the stage's stop_text — the sending number and the provider
  // account can both out-rank it.
  //
  // An EMPTY footer omits the line entirely rather than leaving a trailing
  // newline. That case arises only when the provider appends its own opt-out
  // text (descriptor.appendsOwnOptOut), where a blank line would be a visible
  // artefact on the wire. No adapter sets that flag today and every current
  // stage resolves to a non-empty footer, so this branch changes no existing
  // message — asserted byte-for-byte against the live corpus by
  // scripts/verify-q3-optout-footer.ts.
  const footer = (stopText ?? "").trim();
  const parts = [base];
  if (link.length > 0) parts.push(link);
  if (footer.length > 0) parts.push(footer);
  return parts.join("\n");
}
