import { redirect } from "next/navigation";

// This app is an internal CRM with no public landing page. The root URL
// is a permanent redirect to /dashboard. Logged-out visitors hit the
// proxy.ts middleware and get bounced to /login; logged-in users land
// on the dashboard directly.
export default function RootRedirect() {
  redirect("/dashboard");
}
