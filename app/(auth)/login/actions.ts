"use server";

import { createClient } from "@/lib/supabase/server";
import { loginSchema, type LoginInput } from "@/lib/validators/auth";

export type SignInResult =
  | { ok: true; redirectTo: string }
  | { error: string };

export async function signInAction(
  input: LoginInput,
  next?: string,
): Promise<SignInResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) return { error: error.message };

  const safeNext =
    next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  return { ok: true, redirectTo: safeNext };
}
