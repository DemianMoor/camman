/**
 * Frozen first column — the class bundle, in ONE place.
 *
 * ⭐ OPT-IN PER TABLE, AND IT MUST STAY THAT WAY. `components/data-table.tsx`
 * backs every registry list in the app; freezing a column there by default
 * would change ~20 screens nobody asked about. The wrapper takes a
 * `freezeFirstColumn` prop that defaults to FALSE and only /reports Overview
 * passes it. The By-X table (`components/reports/performance-report.tsx`)
 * hand-rolls its own markup and applies this same constant directly — one
 * bundle, so the two cannot drift.
 *
 * How the cell stays readable while the other columns scroll underneath:
 *
 *   - `sticky left-0` pins it inside the table's existing `overflow-x-auto`
 *     container; `z-10` puts it above its non-positioned siblings so they pass
 *     BEHIND it rather than in front.
 *   - `bg-background` is an OPAQUE base. This is the whole game: the row's own
 *     background is translucent (`bg-muted/50` on hover, nothing at rest), so a
 *     frozen cell that inherited it would show the scrolling columns through
 *     itself.
 *   - `::before` carries the ROW-STATE tint on top of that opaque base, and the
 *     caller supplies it (`[tr:hover>&]:before:bg-muted/50`) because each table
 *     styles its rows differently — the wrapper hovers `muted/50`, the By-X
 *     table `muted/30`, and its header row is a flat `muted/40`. Re-using the
 *     row's OWN utility rather than a hand-mixed opaque equivalent is why the
 *     frozen cell composites to exactly the row's colour, with no seam mid-row.
 *     ⚠️ A frozen table that adds another row state (selected, zebra, an
 *     `onRowClick` hover) must add the matching `…:before:bg-…` class or the
 *     frozen cell will not follow it.
 *   - `before:-z-10` keeps that tint UNDER the cell's content and ABOVE the
 *     cell's own background. Negative z-index children paint inside the sticky
 *     cell's stacking context (it has one: positioned + a z-index), so the tint
 *     can never fall behind the scrolling columns.
 *   - the 1px box-shadow is the boundary edge, visible mid-scroll. It is a
 *     SHADOW and not `border-r` on purpose: under `border-collapse: collapse`
 *     (Tailwind's preflight default for tables) collapsed borders are painted
 *     by the table, not by the cell, so they do not travel with a sticky cell.
 *
 * Nothing here has a width or a layout effect, so a table that does not
 * overflow keeps exactly the LAYOUT it had — no column moves, nothing reflows.
 * It does NOT look identical, though: the box-shadow is unconditional, so the
 * 1px divider down the first column's right edge APPEARS at every width,
 * overflowing or not. That is the one deliberate visual change to a
 * non-overflowing frozen table, and it is the wanted one — the column is a
 * real boundary before the scroll starts, not only during it.
 */
export const FROZEN_FIRST_COLUMN_CELL =
  "sticky left-0 z-10 bg-background shadow-[1px_0_0_0_var(--color-border)] " +
  "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:content-['']";
