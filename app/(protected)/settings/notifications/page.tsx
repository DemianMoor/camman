import type { Metadata } from "next";

import { NotificationSettings } from "@/components/settings/notification-settings";

export const metadata: Metadata = { title: "Notification Settings" };

export default function NotificationSettingsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
        <p className="text-sm text-muted-foreground">
          Configure which Telegram alerts fire and when. All times are Warsaw
          (Europe/Warsaw) — the same timezone the report cron uses internally.
        </p>
      </header>

      <NotificationSettings />
    </div>
  );
}
