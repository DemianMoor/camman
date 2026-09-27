// Cluster mapping for the contact-group × lifecycle breakdown.
//
// ⚠️ CONFIG, NOT QUERY. The mapping is data the SQL joins against, so adding a
// group to a cluster is an edit here and nothing else — no query change, no
// migration. It is passed into the statement as a VALUES list.
//
// ⚠️ KEYED ON contact_groups.contact_group_id (the operator-facing CODE), never
// on the serial `id` or the display name. The serial differs between databases,
// so a preview fixture and production would silently cluster differently; the
// name is editable in the UI, so a rename would empty a cluster without
// anything failing.
//
// A group in NO cluster is not an error and is not hidden — it renders under
// "Unclustered" so a new group appears the day it is created rather than
// waiting for someone to remember this file.

export interface GroupCluster {
  /** Stable key, used in the API shape and the CSV. */
  key: string;
  /** What the operator sees. */
  label: string;
  /** contact_groups.contact_group_id values. */
  codes: readonly string[];
}

export const GROUP_CLUSTERS: readonly GroupCluster[] = [
  {
    key: "weight_loss",
    label: "Weight Loss",
    // ⚠️ "WL Signal Test (Aug 2026)" (wl-s-t) is deliberately NOT here. It is a
    // test list, and the owner named exactly these three (2026-09-27). Folding
    // it in would quietly inflate the number a campaign is sized from.
    codes: ["wl", "wly", "wl_sep_26"],
  },
  { key: "memory", label: "Memory", codes: ["mmr"] },
  { key: "spiritual", label: "Spiritual", codes: ["mnf", "ase"] },
  {
    key: "other_health",
    label: "Other health",
    codes: ["bsr", "nvp", "vsn", "erf"],
  },
] as const;

/** Every code that belongs to some cluster — for the "unclustered" split. */
export const CLUSTERED_CODES: ReadonlySet<string> = new Set(
  GROUP_CLUSTERS.flatMap((c) => c.codes),
);
