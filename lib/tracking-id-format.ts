// Pure tracking-id string composition — NO database or server-only imports,
// so this module is safe to import from client components (the stage form
// computes a live tracking-ID preview before the stage is saved).
//
// Stage tracking_id format: `<campaign_tracking_id>_s<stage_number>_c<creative_id>`
//   e.g. "5_14296_051526_1_s2_c42"
//
// The server (lib/tracking-id.ts) and the stage form both call this so the
// previewed value matches what gets persisted on save.
export function formatStageTrackingId({
  campaignTrackingId,
  stageNumber,
  creativeId,
}: {
  campaignTrackingId: string;
  stageNumber: number;
  creativeId: number;
}): string {
  return `${campaignTrackingId}_s${stageNumber}_c${creativeId}`;
}
