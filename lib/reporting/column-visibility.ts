import type { EventColumn } from "@/lib/reporting/event-columns";

// =============================================================================
// THE CURATED DEFAULT VIEW — what a wide table shows before the operator asks
// for the rest of it.
//
// Both tables outgrew their container once the per-event columns landed:
// /reports By Offer measured 25 columns / 2069px inside a 1126px container and
// /creatives 20 columns / 2084px (2026-09-19, a real browser at 1440px, after
// the label shortening). Shortening the headers removed 16% of the overflow and
// left 84%, so the remaining answer is to show fewer columns by default and let
// the operator ask for the rest.
//
// ⭐ IT IS A RENDER-TIME CHOICE AND NOTHING ELSE. No request parameter changes,
// no aggregate is recomputed, no number moves. Hiding a column never changes
// what the visible ones mean — which is exactly why the residual rule below is
// not negotiable: a column that EXPLAINS another one is not a display detail.
//
// ⭐ THE TOGGLE IS PERSISTED WITH usePersistedFilters, KEYED BY ROUTE — the
// hook CLAUDE.md §9 already mandates for every list view's filters, not a new
// mechanism. It is a per-browser preference like the campaigns list's
// tracking-ID toggle, so two operators can read the same table differently.
// =============================================================================

/**
 * Is this GENERATED column part of the curated default view?
 *
 * ⭐ BY KIND, NEVER BY KEY, AND THAT IS THE WHOLE DESIGN. The central claim of
 * Phase 5 is that adding an event type is CONFIG, not code. A default view
 * spelled as a list of column ids — `evt:registration:count`,
 * `evt:purchase:count` — would be precisely the hard-coding this phase removed:
 * it would happen to match today's two types, and the day a third is configured
 * its count would land behind the toggle BY OMISSION. Silently, with every test
 * green, because nothing in a list of ids can notice a member it never had.
 * scripts/test-reports-no-hardcoded-event-keys.ts is the gate that forbids the
 * id list outright; this predicate is what makes the gate satisfiable.
 *
 * ⭐ THE RULE: a count and a funnel ratio are in; everything else a type
 * generates is held back. A `count` is the type's own headline number — the
 * thing the registry exists to split apart — and the funnel ratio is the
 * owner's stated reason the card exists at all ("that ratio is the reason this
 * card exists — it's the first thing I'll look at"). The two held back at tier
 * A are second-order reads of a number that is on screen either way: a `rate`
 * is the same count over the EPC denominator, and a `pending_n` is a SUBSET of
 * the count beside it. Nothing is hidden that cannot be recovered by eye from
 * something still visible, which is the test a curated view has to pass.
 *
 * ⭐ WHAT A NEWLY CONFIGURED TYPE GETS, STATED RATHER THAN DISCOVERED LATER.
 * One count column in the default view, plus one funnel column for each
 * signal↔purchase pairing it joins; its rate and its held count go behind the
 * toggle, and its money columns keep their own control (below). So the default
 * view grows by ONE column per type — except through the funnel cross product,
 * which is |signals| × |purchases| and is the number to watch if the registry
 * ever grows past a handful of types. That is the right trade today (two types
 * ⇒ one funnel column) and it is written down here so the day it stops being
 * right is a decision rather than a surprise.
 *
 * ⭐ TIER B IS NOT THIS PREDICATE'S BUSINESS. The per-event MONEY columns have
 * had their own per-browser control since Task 5 — the Event-breakdown toggle
 * inside EventColumnsBar, which is bound to the unclassified badge and cannot
 * be mounted without it. Folding them into this one would either delete that
 * control (and with it the Overview tab's only way to reach the money split,
 * which this task did not approve) or leave it governing nothing and unmounting
 * itself. They are therefore EXEMPT from the curated view: see eventColsFor().
 */
export function isDefaultViewEventColumn(col: EventColumn): boolean {
  return col.kind === "count" || col.kind === "funnel";
}

/**
 * The FIXED columns /reports holds back until "Show all columns" is ticked —
 * the owner's list, and the only place it is written down.
 *
 * ⭐ A ROSTER OF IDS IS FINE HERE AND FORBIDDEN ABOVE, because these columns are
 * WRITTEN DOWN in FULL_COLS / HOURLY_COLS. Configuring an event type cannot add
 * one, so there is no "new member lands on the wrong side by omission" failure
 * to design around; adding one is a code change that passes through this file.
 * Bar V10 pins every id here to a real column id in
 * components/reports/performance-report.tsx, and V11 fails on a column that is
 * in NEITHER this roster nor the default view — so a column added to that file
 * without a decision about it is a red bar, not a silent default.
 *
 * Each one is a second-order read of something still on screen: Opt-outs beside
 * OptOut %, Redirects and Redir % beside Clickers and CR %, Sales CR beside
 * Sales, and the all-time EPC pair beside the period pair.
 */
export const REPORTS_EXTRA_COLUMN_IDS: ReadonlySet<string> = new Set([
  "opt_outs",
  "redirects",
  "redirect_rate",
  "sales_cr",
  "lifetime_clickers",
  "lifetime_epc",
]);

/**
 * The same roster for /creatives — the owner's list for that table.
 *
 * The metadata columns (spam score, offers, sequence, funnel stage, status) are
 * filter dimensions rather than performance numbers: the filter bar above the
 * table already selects on every one of them, so the column repeats a choice
 * the operator just made. The all-time trio and Used Campaigns are history
 * beside the 30-day figures the list actually ranks by.
 *
 * ⭐ THE GENERATED COLUMNS ARE NOT IN HERE, AND THEY COULD NOT BE. The count
 * columns are default-visible by the rule above; the manual top-up and the
 * stray count are residuals, handled inside eventCountColumns() where the stray
 * count is appended by a branch that cannot see the toggle at all.
 */
export const CREATIVES_EXTRA_COLUMN_IDS: ReadonlySet<string> = new Set([
  "spam_score",
  "offers",
  "sequence",
  "funnel_stage",
  "status",
  "epc_lifetime",
  "clean_clicks_lifetime",
  "sales_lifetime",
  "used_campaigns",
  "created_at",
]);
