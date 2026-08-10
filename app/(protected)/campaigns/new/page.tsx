import type { Metadata } from "next";

import { CampaignEditorPage } from "@/components/campaigns/campaign-editor-page";

export const metadata: Metadata = { title: "New Campaign" };

export default function NewCampaignPage() {
  return <CampaignEditorPage mode="create" />;
}
