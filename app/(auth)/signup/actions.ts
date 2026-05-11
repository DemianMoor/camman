"use server";

import { createClient } from "@/lib/supabase/server";
import { signupSchema, type SignupInput } from "@/lib/validators/auth";

export type SignUpResult = { ok: true } | { error: string };

export async function signUpAction(input: SignupInput): Promise<SignUpResult> {
  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!siteUrl) {
    return { error: "Server misconfiguration: NEXT_PUBLIC_SITE_URL is not set" };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: parsed.data.displayName
        ? { display_name: parsed.data.displayName }
        : undefined,
      emailRedirectTo: `${siteUrl}/auth/callback`,
    },
  });

  if (error) return { error: error.message };
  return { ok: true };
}
