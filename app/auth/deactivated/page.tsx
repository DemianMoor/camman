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
import { signOutAction } from "@/app/(protected)/actions";

// Where requireOrgMembership() sends a member whose is_active went false.
//
// This page exists because /login cannot do the job: the user still holds a
// valid Supabase session at this point, and proxy.ts bounces any authenticated
// request for /login or /signup back to /dashboard — which redirects here
// again. Sending them to /login would be an infinite loop.
//
// The sign-out button is a client action for the same reason it cannot happen
// during the page render: lib/supabase/server.ts swallows cookie writes made
// from a Server Component, so signOut() from a page body would clear nothing.
export default function DeactivatedPage() {
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function onSignOut() {
    setIsSigningOut(true);
    // Redirects on success, so isSigningOut is deliberately not reset.
    await signOutAction();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Your access has been deactivated</CardTitle>
          <CardDescription>
            This account is no longer active in Campaign Manager. If you think
            this is a mistake, contact the workspace owner.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={onSignOut}
            disabled={isSigningOut}
            className="w-full"
          >
            {isSigningOut ? "Signing out…" : "Sign out"}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
