import { CampaignEditorPage } from "@/components/campaigns/campaign-editor-page";

export default async function EditCampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const campaignId = Number(id);
  return <CampaignEditorPage mode="edit" campaignId={campaignId} />;
}
