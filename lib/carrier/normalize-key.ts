// Carrier match-key normalization (brief §4). Turns a raw Telnyx carrier string
// into a stable key so route/SPID suffix variants collapse to ONE key before the
// mapping/pattern lookup — otherwise the mapping table balloons with near-dupes
// (~15% of observed strings carry route suffixes like `/1`, `-NSR/1`, `-SVR-10X/2`).
//
// Rules:
//   - Strip trailing route/SPID artifacts ending in `/<digits>` (with any run of
//     NSR/SVR/SGV/AST/Port/`10X`/numeric-SPID tokens before the slash), plus a
//     bare trailing `:<digits>` SPID.
//   - Collapse `.` `,` `-` to spaces (KEEP `&` — AT&T stays AT&T); re-collapse
//     whitespace; uppercase.
//
// Examples (from the brief):
//   `T-Mobile US-SVR-10X/2`          -> `T MOBILE US`
//   `Cingular Wireless/2`            -> `CINGULAR WIRELESS`
//   `Keystone Wireless:6921 - SVR/2` -> `KEYSTONE WIRELESS`
//
// Kept deliberately conservative: imperfect stripping is fine because the pattern
// layer (a brand-substring fallback) still catches e.g. `VERIZON FDV`. The key
// only needs to dedupe the FREQUENT mechanical suffixes.

// A trailing route/SPID tail: an optional run of `<delim><token>` groups, then an
// optional delimiter, then `/<digits>`. Anchored at end.
const ROUTE_TAIL =
  /(?:[\s:_-]+(?:NSR|SVR|SGV|AST|PORT|[0-9]+X|[0-9]{3,}[A-Z]?))*[\s:_-]*\/\s*[0-9]+\s*$/i;

// A bare trailing `:<digits>` SPID (no slash), e.g. `...:6006`.
const BARE_SPID = /:\s*[0-9]{3,}[A-Z]?\s*$/i;

export function normalizeCarrierKey(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.trim();
  if (!s) return "";
  s = s.replace(ROUTE_TAIL, "");
  s = s.replace(BARE_SPID, "");
  s = s
    .replace(/[.,\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return s;
}
