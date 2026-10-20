import type { Metadata } from "next";

import { MessageFormatsPanel } from "@/components/settings/message-formats-panel";
import { requirePagePermission } from "@/lib/authz/page-guard";

export const metadata: Metadata = { title: "Message Formats" };

export default async function MessageFormatsSettingsPage() {
  await requirePagePermission("message_formats.view");
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Message formats</h1>
        <p className="text-sm text-muted-foreground">
          How the brand, creative text, link and opt-out text are put together into the SMS. Each stage
          picks one enabled format; new stages start with the default.
        </p>
      </header>
      <MessageFormatsPanel />
    </div>
  );
}
