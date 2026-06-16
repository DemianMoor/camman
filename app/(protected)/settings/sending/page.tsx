import { SendToggle } from "@/components/settings/send-toggle";

export default function SendingSettingsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Sending</h1>
        <p className="text-sm text-muted-foreground">
          Control whether this organization can send real SMS, without a redeploy.
        </p>
      </header>

      <SendToggle />
    </div>
  );
}
