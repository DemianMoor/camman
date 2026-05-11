"use server";

import { createClient } from "@/lib/supabase/server";
import {
  requestPasswordResetSchema,
  type RequestPasswordResetInput,
} from "@/lib/validators/auth";

export type RequestPasswordResetResult = { ok: true } | { error: string };

export async function requestPasswordResetAction(
  input: RequestPasswordResetInput,
): Promise<RequestPasswordResetResult> {
  const parsed = requestPasswordResetSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!siteUrl) {
    return { error: "Server misconfiguration: NEXT_PUBLIC_SITE_URL is not set" };
  }

  const supabase = await createClient();
  // We always return ok=true regardless of whether the email exists.
  // Revealing account existence is an information-disclosure issue.
  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${siteUrl}/auth/reset-password`,
  });

  return { ok: true };
}
