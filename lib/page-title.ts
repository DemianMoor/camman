import type { Metadata } from "next";

// Browser tab titles. The root layout owns the shape; every other segment
// contributes only its own bare name. See docs/07-conventions.md § Browser tab
// titles.

/** Brand suffix applied to every page title. `%s` is the segment's own title. */
export const TITLE_TEMPLATE = "%s - Camman";

/** Fallback for any route that sets no title of its own. */
export const TITLE_DEFAULT = "Camman";

/**
 * Title for a segment that has titled descendants (e.g. `/campaigns`, which
 * sits above `/campaigns/new` and `/campaigns/[id]`).
 *
 * A plain-string `title` **nulls the inherited template for deeper segments**,
 * so such a segment must re-declare it — otherwise nested routes render bare
 * ("Campaign" instead of "Campaign - Camman"). Note the template is applied to
 * `default` too, so pass the bare name here, not one with the suffix baked in.
 *
 * Leaf segments don't need this: `title: "Brands"` is enough.
 */
export function sectionTitle(title: string): Metadata["title"] {
  return { default: title, template: TITLE_TEMPLATE };
}
