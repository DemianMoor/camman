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
import { signInAction } from "./actions";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? undefined;
  const urlError = searchParams.get("error");
  const resetSuccess = searchParams.get("reset") === "success";

  const [formError, setFormError] = useState<string | null>(
    urlError === "verification_failed"
      ? "We couldn't verify your email. Please try again or request a new link."
      : null,
  );

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
          Enter your email and password to continue.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {resetSuccess ? (
          <p className="mb-4 text-sm text-muted-foreground">
            Password updated. Sign in with your new password.
          </p>
        ) : null}
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
            {formError ? (
              <p className="text-sm text-destructive">{formError}</p>
            ) : null}
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
              <p>
                Don&apos;t have an account?{" "}
                <Link
                  href="/signup"
                  className="text-foreground underline underline-offset-4"
                >
                  Sign up
                </Link>
              </p>
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
