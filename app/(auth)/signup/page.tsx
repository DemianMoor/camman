import Link from "next/link";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Self-signup is closed (ClickUp 869et3vm1, Phase 1). The route is kept rather
// than deleted so an old bookmark or an emailed link lands on an explanation
// instead of a 404.
//
// The real enforcement is in ./actions.ts — a Server Action stays callable
// even with no UI pointing at it, so deleting this page would not have closed
// anything.
export default function SignupPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Sign-up is closed</CardTitle>
          <CardDescription>
            Campaign Manager accounts are created by invitation only.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm text-muted-foreground">
          <p>
            Ask the workspace owner to invite your work email address. Once
            invited, sign in with Google — no password needed.
          </p>
          <Link
            href="/login"
            className="text-foreground underline underline-offset-4"
          >
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
