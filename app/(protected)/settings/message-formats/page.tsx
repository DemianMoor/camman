import type { Metadata } from "next";

import { MessageFormatsPanel } from "@/components/settings/message-formats-panel";
import { requirePagePermission } from "@/lib/authz/page-guard";
import { messageFormatsUiEnabled } from "@/lib/messages/ui-flag";

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
      {!messageFormatsUiEnabled() ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          The message-format controls are switched off: stages do not show a format picker yet, and every
          message goes out in the default T1 shape (Brand: creative / link / opt-out text). Changes made here
          have no effect on any stage until the controls are switched on.
        </p>
      ) : null}
      <MessageFormatsPanel />
    </div>
  );
}
