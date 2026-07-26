// Roll the per-stage dashboard rows up into "which campaigns are send-paused, and
// how much is stuck behind each pause". Shared by /api/sends/today and
// /api/sends/autopilot so the two banners can't drift.
//
// PURE, and computed from rows the routes already fetched — no extra query. The
// campaign columns come from the campaigns row those routes already join.

export interface PausedCampaignSummary {
  campaign_id: number;
  campaign_name: string;
  /** campaigns.send_paused_reason — the breaker's audit string, or "manual". */
  reason: string | null;
  paused_at: string | null;
  /** Stages of this campaign that read `blocked` in the current view. */
  held_stages: number;
  /** Messages sitting `pending` on those blocked stages. */
  held_messages: number;
}

export interface PausedCampaignInputRow {
  campaign_id: number;
  campaign_name: string;
  campaign_paused: boolean;
  campaign_paused_reason: string | null;
  campaign_paused_at: string | null;
  operational_status: string;
  counts: { pending: number };
}

export function summarizePausedCampaigns(
  rows: PausedCampaignInputRow[],
): PausedCampaignSummary[] {
  const byCampaign = new Map<number, PausedCampaignSummary>();
  for (const r of rows) {
    if (!r.campaign_paused) continue;
    let entry = byCampaign.get(r.campaign_id);
    if (!entry) {
      entry = {
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        reason: r.campaign_paused_reason,
        paused_at: r.campaign_paused_at,
        held_stages: 0,
        held_messages: 0,
      };
      byCampaign.set(r.campaign_id, entry);
    }
    // Only stages that still have work count as held — a stage that finished
    // before the pause isn't affected by it (see deriveStageOperationalStatus).
    if (r.operational_status === "blocked") {
      entry.held_stages += 1;
      entry.held_messages += r.counts.pending;
    }
  }
  // Biggest backlog first; a paused campaign with nothing held still lists (the
  // pause itself is the thing the operator needs to see).
  return [...byCampaign.values()].sort(
    (a, b) => b.held_messages - a.held_messages || a.campaign_name.localeCompare(b.campaign_name),
  );
}
