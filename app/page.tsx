import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { db } from "@/db/client";
import {
  appHostname,
  lookupBrandWebsiteByHost,
  resolveRootTarget,
} from "@/lib/links/root-redirect";

// Root path "/" handling.
//
// - App host (and dev/unknown hosts matching the app): redirect to /dashboard
//   exactly as before — the app, auth, and all routes are unchanged.
// - Short-link host (Host matches an active short_domains row with a brand
//   website): redirect to that brand's website (bare-root redirect).
// - No match / no website / DB hiccup: fall through to /dashboard.
//
// This is the ONLY consumer of this behavior — it fires only for the exact
// path "/". /r/[code] is a separate route and is untouched. The lookup runs in
// the Node runtime (Drizzle); the Edge middleware can't reach Postgres.
export default async function RootRedirect() {
  const h = await headers();
  const host = (h.get("host") ?? "").toLowerCase().split(":")[0];
  const appHost = appHostname(process.env.NEXT_PUBLIC_SITE_URL);

  let target = "/dashboard";
  try {
    target = await resolveRootTarget({
      host,
      appHost,
      lookupWebsite: (hostname) => lookupBrandWebsiteByHost(db, hostname),
    });
  } catch {
    // A lookup failure must never break the root — fall through to the app.
    target = "/dashboard";
  }

  // redirect() is called outside the try so its NEXT_REDIRECT isn't swallowed.
  redirect(target);
}
