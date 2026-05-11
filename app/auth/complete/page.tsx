"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { recheckMembershipAction } from "./actions";

export default function AuthCompletePage() {
  const [stillMissing, setStillMissing] = useState(false);
  const [isChecking, setIsChecking] = useState(false);

  async function onRetry() {
    setIsChecking(true);
    const result = await recheckMembershipAction();
    // If membership was found, the action redirects and this line is unreachable.
    if (result?.stillMissing) {
      setStillMissing(true);
      setIsChecking(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Setting up your account…</CardTitle>
          <CardDescription>
            We&apos;re finishing the last setup steps for your workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {stillMissing ? (
            <p className="text-sm text-destructive">
              Your account is still missing its workspace. Please contact
              support so we can fix this.
            </p>
          ) : null}
          <Button onClick={onRetry} disabled={isChecking}>
            {isChecking ? "Checking…" : "Continue"}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
