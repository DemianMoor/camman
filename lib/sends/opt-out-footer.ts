// THE single source of truth for which opt-out footer ships on a message.
//
// PURE and CLIENT-SAFE — no DB, no server imports — because the stage form's
// live preview and the send path must reach the same answer from the same
// function. Same pattern as lib/links/tracked-link.ts (B2): the callers supply
// candidates, this decides. If the preview and the send path each ranked the
// candidates themselves, an operator could edit a field that never ships, or —
// far worse — the kickoff compliance gate could validate text the recipient
// never sees.
//
// PRECEDENCE, most specific first:
//
//   1. provider_phones.opt_out_footer   the sending NUMBER      (migration 0141)
//   2. sms_providers.opt_out_footer     the ACCOUNT             (migration 0138)
//   3. campaign_stages.stop_text        the STAGE               (what ships today)
//   4. DEFAULT_OPT_OUT_FOOTER           the built-in floor
//
// Deliberately NOT in the chain:
//   • the creative — excluded by decision; copy and compliance text stay apart.
//   • descriptor.defaultOptOutFooter — a UI seed/suggestion shown when an
//     operator is choosing wording. It is never a runtime candidate. Its ONLY
//     runtime role is as the reference text for validating a provider that
//     appends its own footer (see below), which is a check, not a choice.

export const DEFAULT_OPT_OUT_FOOTER = "Stop to END";

/** Which level of the chain supplied the text that will ship. */
export type OptOutFooterLevel =
  | "number"
  | "provider"
  | "stage"
  | "default"
  /** The provider appends its own; CamMan appends nothing. */
  | "provider_appends";

export interface ResolvedOptOutFooter {
  /**
   * The text CamMan renders into the body. EMPTY STRING when the provider
   * appends its own — in that case CamMan must add nothing, and the body must
   * not carry a stray blank line where the footer would have been.
   */
  text: string;
  level: OptOutFooterLevel;
  /** True ⇒ the on-wire opt-out language comes from the provider, not from us. */
  appendedByProvider: boolean;
}

const clean = (v: string | null | undefined): string => (v ?? "").trim();

// Resolve the footer. Callers supply whatever candidates they have; absent /
// blank candidates fall through. Trimming is deliberate: a field containing
// only whitespace states no preference, and treating it as a value would ship a
// message whose opt-out line is invisible.
export function resolveOptOutFooter(opts: {
  numberFooter?: string | null;
  providerFooter?: string | null;
  stageStopText?: string | null;
  /** descriptor.appendsOwnOptOut for the stage's connection type. */
  providerAppendsOwnOptOut?: boolean;
}): ResolvedOptOutFooter {
  // The provider appending its own text out-ranks every candidate, because
  // appending ours as well would put TWO opt-out instructions in one message —
  // which is worse than either alone: it doubles the length and invites the
  // recipient to use the wrong keyword.
  if (opts.providerAppendsOwnOptOut === true) {
    return { text: "", level: "provider_appends", appendedByProvider: true };
  }

  const number = clean(opts.numberFooter);
  if (number) return { text: number, level: "number", appendedByProvider: false };

  const provider = clean(opts.providerFooter);
  if (provider) return { text: provider, level: "provider", appendedByProvider: false };

  const stage = clean(opts.stageStopText);
  if (stage) return { text: stage, level: "stage", appendedByProvider: false };

  return { text: DEFAULT_OPT_OUT_FOOTER, level: "default", appendedByProvider: false };
}

/** Operator-facing label for the winning level — the preview names it so an
 *  operator is never editing a field that will not ship. */
export function describeOptOutFooterLevel(level: OptOutFooterLevel): string {
  switch (level) {
    case "number":
      return "this sending number";
    case "provider":
      return "the provider account";
    case "stage":
      return "this stage's STOP text";
    case "provider_appends":
      return "the provider (it appends its own)";
    case "default":
      return "the system default";
  }
}

// ── The compliance gate's subject ────────────────────────────────────────────
//
// The kickoff gate must validate THE TEXT THAT SHIPS. Before Q3 it checked the
// rendered body, which carried campaign_stages.stop_text — correct only while
// stop_text was the only possible source. With a chain in place, validating a
// field that lost the resolution would pass a message whose actual footer is
// something else entirely.
//
// Two cases:
//   • CamMan appends  → validate the rendered body (it contains the winner).
//   • Provider appends → the body has no footer of ours, so validate the
//     provider's KNOWN appended text instead.
//
// FAILS CLOSED. If a connection type claims to append its own footer but
// declares no known text, we cannot demonstrate that a STOP keyword ships — so
// the answer is "cannot verify", and a compliance gate that cannot verify must
// refuse. Never assume an unseen provider footer is adequate.
export function optOutGateSubject(opts: {
  renderedBody: string;
  resolved: ResolvedOptOutFooter;
  /** descriptor.defaultOptOutFooter — the provider's KNOWN appended wording. */
  providerKnownAppendedText?: string | null;
}): { subject: string; verifiable: boolean } {
  if (!opts.resolved.appendedByProvider) {
    return { subject: opts.renderedBody, verifiable: true };
  }
  const known = clean(opts.providerKnownAppendedText);
  if (!known) return { subject: "", verifiable: false };
  return { subject: known, verifiable: true };
}

/**
 * Does this text carry a standalone STOP keyword?
 *
 * ⚠️ EXPORTED SO IT CAN BE TESTED. It was inline in the drip scheduler, where a
 * patch silently replaced the two `\b` word boundaries with literal BACKSPACE
 * characters (0x08). The line still compiled, still read correctly on screen and
 * in a diff, and the regex could never match — so the gate refused every txr
 * lead. It failed closed, so nothing wrong was sent; nothing at all was sent
 * either, and the counters were the only visible symptom.
 *
 * ⚠️ THE WORD BOUNDARIES ARE LOAD-BEARING: "stopped snacking" is a real creative
 * opening and must NOT count as opt-out language.
 */
export function bodyCarriesStop(subject: string): boolean {
  return /\bSTOP\b/i.test(subject);
}
