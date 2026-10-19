// Message FORMAT grammar — how brand, creative text, link and opt-out footer are
// assembled into one SMS body. PURE and CLIENT-SAFE.
//
// Grammar (spec B2):
//   blocks     {brand} {creative_text} {url} {stop_text}
//   row break  <new_row>  → "\n"
//   everything else is literal.
// Rules:
//   • single pass — block VALUES are substituted verbatim and never re-scanned;
//   • url and stop_text values are trimmed; brand and creative_text are not;
//   • a row whose template is EXACTLY one block, rendering empty, is dropped
//     (today's "no link ⇒ no link line"); any other empty row is kept, except
//   • trailing blank rows (empty / whitespace-only) are trimmed;
//   • an empty creative ⇒ "" (nothing to send).
// With these rules T1 reproduces the pre-format buildStageSms byte-for-byte.

import { BLOCK_KEYS, type TagKey } from "./tags";

export type BlockKey = (typeof BLOCK_KEYS)[number];

export const NEW_ROW = "<new_row>";

export const T1_TEMPLATE = "{brand}: {creative_text}<new_row>{url}<new_row>{stop_text}";

/** Seeded per org by ensure_message_formats (0216). T1 = today's shape, the default. */
export const SEED_FORMATS: readonly { name: string; template: string; isDefault: boolean }[] = [
  { name: "T1 — Brand prefix", template: T1_TEMPLATE, isDefault: true },
  { name: "T2 — Brand inline", template: "{creative_text} {brand} {stop_text}<new_row><new_row>{url}", isDefault: false },
  { name: "T3 — Brand in creative", template: "{creative_text}<new_row>{url}<new_row>{stop_text}", isDefault: false },
];

const TOKEN = /\{(brand|creative_text|url|stop_text|first_name|zip|state)\}/g;
const ONLY_BLOCK = /^\{(brand|creative_text|url|stop_text)\}$/;
const REQUIRED_TEMPLATE_BLOCKS: readonly BlockKey[] = ["creative_text", "url", "stop_text"];

export type TemplateError = { code: "unknown_token" | "missing_block"; detail: string };

const missingBlock = (t: string, required: readonly BlockKey[]) => required.find((b) => !t.includes(`{${b}}`));

/** Org templates: block tokens only; creative_text, url and stop_text required. */
export function validateTemplate(t: string): TemplateError | null {
  for (const m of t.matchAll(/\{[^{}]*\}/g)) {
    if (!(BLOCK_KEYS as readonly string[]).includes(m[0].slice(1, -1))) return { code: "unknown_token", detail: m[0] };
  }
  const missing = missingBlock(t, REQUIRED_TEMPLATE_BLOCKS);
  return missing ? { code: "missing_block", detail: `{${missing}}` } : null;
}

/**
 * Owner-only custom stage text: blocks, tags and literal text. {creative_text},
 * {url} and {stop_text} are required (owner ruling 2026-10-19). Unknown brace
 * tokens are literal, as in creatives.
 */
export function validateCustomText(t: string): { code: "custom_text_missing_required_block"; detail: string } | null {
  const missing = missingBlock(t, REQUIRED_TEMPLATE_BLOCKS);
  return missing ? { code: "custom_text_missing_required_block", detail: `{${missing}}` } : null;
}

/**
 * `tags` is only for owner custom text, where tags sit in the template itself:
 * they are substituted in the SAME single pass as the blocks, so no value — a
 * brand or a name — is ever re-read as template syntax.
 */
export function assembleMessage(
  template: string,
  v: Record<BlockKey, string>,
  tags: Partial<Record<TagKey, string>> = {},
): string {
  if (!v.creative_text) return "";
  const value = (k: BlockKey): string =>
    k === "url" || k === "stop_text" ? (v[k] ?? "").trim() : (v[k] ?? "");
  const rows: string[] = [];
  for (const row of template.split(NEW_ROW)) {
    const only = row.match(ONLY_BLOCK);
    if (only && value(only[1] as BlockKey) === "") continue;
    rows.push(
      row.replace(TOKEN, (token: string, k: string) =>
        (BLOCK_KEYS as readonly string[]).includes(k) ? value(k as BlockKey) : (tags[k as TagKey] ?? token),
      ),
    );
  }
  // Trailing blank ROWS are trimmed (owner, 2026-10-19): T2 with no link must
  // end on its stop text, not "\n". Rows are template rows, so a creative whose
  // own text ends in "\n" is untouched — exactly as the pre-format composer.
  while (rows.length > 0 && rows[rows.length - 1].trim() === "") rows.pop();
  return rows.join("\n");
}
