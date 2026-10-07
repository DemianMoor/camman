import { escapeHtml } from "@/lib/alerts/telegram";

// Pure formatter for the hourly partner-intake Telegram digest. No DB, no
// network — scripts/test-intake-digest-format.ts drives it directly. The data
// side (and why each number means what it means) is lib/drip/intake-digest.ts.
//
// Sent with parse_mode "HTML": every partner/tag string is escaped AFTER its
// column padding is computed, so an "&" in a tag cannot shift the table.

/** One partner key x interest tag for the digested hour. */
export interface DigestRow {
  partner: string; // partner_keys.partner_slug
  tag: string; // resolved tag, '' = untagged
  received: number;
  mobile: number;
  voip: number;
  unknown: number;
  landline: number;
  lookups: number;
}

/** A (partner, tag) whose hourly rows don't add up to its daily row. */
export interface InvariantBreak {
  partner: string;
  tag: string;
  column: string;
  hourlySum: number;
  daily: number;
}

export interface DigestInput {
  /** "13:00–14:00 ET · Tue 7 Oct" — rendered by the caller (timezone-aware). */
  windowLabel: string;
  rows: DigestRow[];
  /** USD per lookup — the partner report's calibrated rate. */
  rate: number;
  /** Telnyx available credit, null when the balance call failed. */
  balanceUsd: number | null;
  /** ET day the invariant covered, and what it found (null = not checked). */
  invariant: { day: string; breaks: InvariantBreak[] } | null;
  /** Set on the first digest ever: the ET label of the hour tracking began. */
  firstDigestNote: string | null;
  /** Prefix for a re-run triggered by hand, so it isn't mistaken for a new hour. */
  manual: boolean;
}

/** Telegram rejects >4096; stay well under, like the performance report. */
export const MAX_DIGEST_CHARS = 3500;

const untagged = (t: string) => (t === "" ? "(untagged)" : t);

export function formatUsd(n: number): string {
  // Sub-dollar hours are the common case (a few hundred lookups at ~$0.0016);
  // two decimals would print most of them as $0.00 — the exact failure the
  // per-batch ledger delta had.
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function header(i: DigestInput, part: string): string {
  return `📥 <b>Partner intake</b> · ${escapeHtml(i.windowLabel)}${i.manual ? " (manual re-run)" : ""}${part}`;
}

function otherLine(r: DigestRow): string {
  return `voip ${r.voip} · unknown ${r.unknown} · landline ${r.landline}`;
}

function footer(i: DigestInput): string[] {
  const lines: string[] = [];
  if (i.invariant && i.invariant.breaks.length > 0) {
    const shown = i.invariant.breaks.slice(0, 3).map(
      (b) =>
        `${escapeHtml(b.partner)}/${escapeHtml(untagged(b.tag))} ${b.column} ${b.hourlySum}≠${b.daily}`,
    );
    const more = i.invariant.breaks.length - shown.length;
    lines.push(
      `⚠️ Day-sum check FAILED for ${i.invariant.day}: hourly rows ≠ daily row — ` +
        shown.join("; ") +
        (more > 0 ? `; +${more} more` : "") +
        ". Hourly numbers above may be wrong; daily partner report is the reference.",
    );
  }
  // No rate-derivation line: the owner dropped it (2026-10-07) as noise. Cost
  // is still lookups × the calibrated rate — see lib/drip/intake-digest.ts.
  lines.push(
    `Telnyx balance: ${i.balanceUsd == null ? "n/a (balance check failed)" : formatUsd(i.balanceUsd)}`,
  );
  if (i.firstDigestNote) lines.push(`ℹ️ ${escapeHtml(i.firstDigestNote)}`);
  return lines;
}

function table(rows: DigestRow[], rate: number, withTotal: boolean): string {
  const cells = rows.map((r) => [
    r.partner,
    untagged(r.tag),
    String(r.received),
    String(r.mobile),
    String(r.lookups),
    formatUsd(r.lookups * rate),
  ]);
  if (withTotal) {
    const sum = (k: keyof DigestRow) => rows.reduce((a, r) => a + (r[k] as number), 0);
    const lookups = sum("lookups");
    cells.push([
      "TOTAL",
      "",
      String(sum("received")),
      String(sum("mobile")),
      String(lookups),
      formatUsd(lookups * rate),
    ]);
  }
  const head = ["Partner", "Tag", "Leads", "Mobile", "Lookups", "Cost"];
  const all = [head, ...cells];
  const widths = head.map((_, c) => Math.max(...all.map((row) => row[c].length)));
  // Text columns left-aligned, numbers right-aligned.
  const fmt = (row: string[]) =>
    row
      .map((v, c) => escapeHtml(c < 2 ? v.padEnd(widths[c]) : v.padStart(widths[c])))
      .join(" ")
      .trimEnd();
  const lines = all.map(fmt);
  if (withTotal) lines.splice(lines.length - 1, 0, "-".repeat(lines[0].length));
  return `<pre>${lines.join("\n")}</pre>`;
}

function otherLines(rows: DigestRow[]): string[] {
  return rows
    .filter((r) => r.voip + r.unknown + r.landline > 0)
    .map((r) => `${escapeHtml(r.partner)}/${escapeHtml(untagged(r.tag))}: ${otherLine(r)}`);
}

/**
 * Render the digest as one or more Telegram messages.
 *
 * One partner x tag → compact lines. Several → a monospace table with a totals
 * row. Over MAX_DIGEST_CHARS the rows are split BY PARTNER across messages
 * (a partner is only broken up if it alone doesn't fit); the totals row and the
 * footer go on the last message only. Returns [] when there are no rows — the
 * caller sends nothing for an hour with no intake.
 */
export function formatIntakeDigest(input: DigestInput): string[] {
  const rows = [...input.rows].sort(
    (a, b) => a.partner.localeCompare(b.partner) || a.tag.localeCompare(b.tag),
  );
  if (rows.length === 0) return [];
  const totalLookups = rows.reduce((a, r) => a + r.lookups, 0);

  if (rows.length === 1) {
    const r = rows[0];
    return [
      [
        header(input, ""),
        `<b>${escapeHtml(r.partner)} / ${escapeHtml(untagged(r.tag))}</b>: ` +
          `${r.received} leads · ${r.mobile} mobile`,
        otherLine(r),
        `Lookups: ${r.lookups} · cost ${formatUsd(r.lookups * input.rate)}`,
        "",
        ...footer(input),
      ].join("\n"),
    ];
  }

  const whole = [
    header(input, ""),
    table(rows, input.rate, true),
    ...otherLines(rows),
    "",
    ...footer(input),
  ].join("\n");
  if (whole.length <= MAX_DIGEST_CHARS) return [whole];

  // ── oversized: pack partner groups greedily ──────────────────────────────
  // Budget each chunk against the larger of the two shells (a middle chunk has
  // no footer; the last has the footer + a totals row), so no chunk can exceed
  // the limit once its shell is added.
  const shellCost =
    header(input, " (part 99/99)").length +
    footer(input).join("\n").length +
    200; // table header/separator/total row + newlines
  const budget = MAX_DIGEST_CHARS - shellCost;
  const rowCost = (r: DigestRow) =>
    table([r], input.rate, false).length + otherLines([r]).join("\n").length + 2;

  const groups = new Map<string, DigestRow[]>();
  for (const r of rows) groups.set(r.partner, [...(groups.get(r.partner) ?? []), r]);

  const chunks: DigestRow[][] = [];
  let cur: DigestRow[] = [];
  let curCost = 0;
  const flush = () => {
    if (cur.length) chunks.push(cur);
    cur = [];
    curCost = 0;
  };
  for (const g of groups.values()) {
    const gCost = g.reduce((a, r) => a + rowCost(r), 0);
    if (gCost <= budget) {
      if (curCost + gCost > budget) flush();
      cur.push(...g);
      curCost += gCost;
      continue;
    }
    // A single partner bigger than a message: split its rows.
    flush();
    for (const r of g) {
      if (curCost + rowCost(r) > budget) flush();
      cur.push(r);
      curCost += rowCost(r);
    }
    flush();
  }
  flush();

  const totalReceived = rows.reduce((a, r) => a + r.received, 0);
  const totalMobile = rows.reduce((a, r) => a + r.mobile, 0);
  return chunks.map((chunk, idx) => {
    const last = idx === chunks.length - 1;
    const part = ` (part ${idx + 1}/${chunks.length})`;
    const body = [header(input, part), table(chunk, input.rate, false), ...otherLines(chunk)];
    if (!last) return body.join("\n");
    return [
      ...body,
      `<b>TOTAL (all parts)</b>: ${totalReceived} leads · ${totalMobile} mobile · ` +
        `${totalLookups} lookups · ${formatUsd(totalLookups * input.rate)}`,
      "",
      ...footer(input),
    ].join("\n");
  });
}
