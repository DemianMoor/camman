"use client";

import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { loginSchema, type LoginInput } from "@/lib/validators/auth";
import { signInAction, signInWithGoogleAction } from "./actions";

// Refusals arrive as ?error= from app/auth/callback/route.ts, which cannot
// carry a message body through a redirect. Kept deliberately vague for
// `not_authorized`: telling an outsider whether an address is allow-listed
// turns the login page into a membership oracle.
const URL_ERRORS: Record<string, string> = {
  verification_failed:
    "We couldn't verify your email. Please try again or request a new link.",
  not_authorized:
    "That account can't sign in to Campaign Manager. Ask the workspace owner for access.",
  deactivated: "Your access has been deactivated.",
};

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? undefined;
  const urlError = searchParams.get("error");
  const resetSuccess = searchParams.get("reset") === "success";

  const [formError, setFormError] = useState<string | null>(
    URL_ERRORS[urlError ?? ""] ?? null,
  );
  const [googlePending, setGooglePending] = useState(false);

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: LoginInput) {
    setFormError(null);
    const result = await signInAction(values, next);
    if ("error" in result) {
      setFormError(result.error);
      return;
    }
    router.push(result.redirectTo);
    router.refresh();
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Sign in to Campaign Manager</CardTitle>
        <CardDescription>
          Sign in with your work Google account.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {resetSuccess ? (
          <p className="mb-4 text-sm text-muted-foreground">
            Password updated. Sign in with your new password.
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={googlePending}
          onClick={async () => {
            setFormError(null);
            setGooglePending(true);
            // On success this redirects to Google and never returns, so
            // googlePending is only reset on the error path.
            const result = await signInWithGoogleAction(next);
            if (result?.error) {
              setFormError(result.error);
              setGooglePending(false);
            }
          }}
        >
          {googlePending ? "Redirecting…" : "Sign in with Google"}
        </Button>
        {formError ? (
          <p className="mt-3 text-sm text-destructive">{formError}</p>
        ) : null}
        <div className="my-5 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">
            or sign in with a password
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="grid gap-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      autoComplete="email"
                      placeholder="you@example.com"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Password</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {/* formError is rendered once, above the divider, so a Google
                refusal and a password refusal appear in the same place. */}
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? "Signing in…" : "Sign in"}
            </Button>
            <div className="flex flex-col gap-1 text-sm text-muted-foreground">
              <Link
                href="/auth/forgot-password"
                className="text-foreground underline underline-offset-4"
              >
                Forgot password?
              </Link>
              {/* No "Sign up" link: self-signup is closed (869et3vm1 Phase 1).
                  Access is granted by an Owner invite, not self-service. */}
              <p>Access is granted by the workspace owner.</p>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-6">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
