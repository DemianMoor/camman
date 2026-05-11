"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { signOutAction } from "./actions";

export function SignOutButton() {
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function onClick() {
    setIsSubmitting(true);
    await signOutAction();
    // signOutAction redirects, so we don't reset isSubmitting on success.
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={isSubmitting}
    >
      {isSubmitting ? "Signing out…" : "Sign out"}
    </Button>
  );
}
