import type { Metadata } from "next";

import { CampaignEditorPage } from "@/components/campaigns/campaign-editor-page";
import { entityTitle } from "@/lib/entity-title";

// Shares the React.cache'd lookup with the parent campaigns/[id] layout, whose
// generateMetadata also runs on this route — so naming the campaign here costs
// no extra query, and the parent's lookup isn't wasted on a title we discard.
// entityTitle's fallback composes: a miss yields plain "Edit Campaign".
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `Edit ${await entityTitle("campaign", id, "Campaign")}` };
}

export default async function EditCampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const campaignId = Number(id);
  return <CampaignEditorPage mode="edit" campaignId={campaignId} />;
}
