import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { requireApiMembership } from "@/lib/api/helpers";
import { newCampaignUsesLifecycleRules } from "@/lib/engagement/lifecycle-gate";
import { can } from "@/lib/permissions";

// ONE BOOLEAN: will a campaign created right now be a lifecycle campaign?
//
// ⚠️ THIS EXISTS BECAUSE THE FORM WAS ASKING A ROUTE THE OPERATOR CANNOT REACH.
// It read /api/settings/lifecycle, which is `null` in the route map —
// lifecycle.configure is manager+, and there is no operator path. The fetch
// 403'd, the catch fell back to "off", and every operator saw "Lifecycle engine
// is off — campaign uses legacy filters" with read-only legacy chips.
//
// That was not a cosmetic wrong, which is what the fallback's comment assumed.
// The CREATE route decides lifecycle_rules server-side from the same engine
// posture, so the campaign would have been created as a lifecycle campaign
// whatever the form showed — and a lifecycle campaign whose audience_filters
// carry legacy toggles has NO lifecycle_statuses, which the chip predicate
// reads as "match nobody" (§3e). The operator would have built a campaign
// addressed to no one.
//
// So the form asks for the one fact it needs instead of for the settings
// object. `campaigns.view` is the right gate: this says nothing about
// thresholds, only which editor to draw, and it is exactly the decision the
// create route will make for this member.
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireApiMembership({
    route: "campaigns/lifecycle-mode",
    method: "GET",
  });
  if ("error" in auth) return auth.error;
  if (!can(auth.role, "campaigns.view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const lifecycleRules = await newCampaignUsesLifecycleRules(db, auth.orgId);
  return NextResponse.json({ lifecycle_rules: lifecycleRules });
}
