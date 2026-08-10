import type { Metadata } from "next";

import { CampaignEditorPage } from "@/components/campaigns/campaign-editor-page";

// Static — the campaign name is fetched client-side by CampaignEditorPage, and
// there is no server-side cached fetcher to reuse, so naming the campaign here
// would mean a second DB round trip per render.
export const metadata: Metadata = { title: "Edit Campaign" };

export default async function EditCampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const campaignId = Number(id);
  return <CampaignEditorPage mode="edit" campaignId={campaignId} />;
}
