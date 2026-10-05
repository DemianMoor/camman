import { db } from "@/db/client";
import type { Role } from "@/lib/permissions";
import { readTrialState, TEXTED_TRIAL_TARGET_NIGHTS } from "@/lib/segments/texted-rule-trial";

// The "Texted in the last…" rule (texted_in_last_period) may be ADDED — a new
// rule, or an existing rule switched to this type — only by the owner until the
// nightly trial's streak reaches TEXTED_TRIAL_TARGET_NIGHTS (owner, 2026-10-05).
// After that, by every role that may edit rules.
//
// Enforced on the SERVER (POST /api/segments/[id]/rules, PATCH …/[ruleId]); the
// Rules panel only hides the option, from the same flag returned by the GET.
// Hiding alone would be rendering, not a control. Editing an existing rule of
// this type (operator, value, active) is not "adding" and stays allowed.
export const TEXTED_RULE_TYPE = "texted_in_last_period";

export async function textedRuleAvailable(orgId: string, role: Role): Promise<boolean> {
  if (role === "owner") return true;
  const state = await readTrialState(db, orgId);
  return (state?.streak ?? 0) >= TEXTED_TRIAL_TARGET_NIGHTS;
}

export const TEXTED_RULE_LOCKED_MESSAGE =
  "The \"Texted in the last…\" rule is in its 14-night trial; until it completes only the owner can add it.";
