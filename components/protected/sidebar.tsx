import Link from "next/link";
import { Megaphone } from "lucide-react";

import {
  Avatar,
  AvatarFallback,
} from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { SignOutButton } from "@/app/(protected)/sign-out-button";
import { SidebarNav } from "./sidebar-nav";

function initialFromEmail(email: string | undefined) {
  if (!email) return "?";
  return email.charAt(0).toUpperCase();
}

export function Sidebar({
  userEmail,
}: {
  userEmail: string | undefined;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 px-4">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 text-sm font-semibold tracking-tight"
        >
          <Megaphone className="size-5" aria-hidden />
          Campaign Manager
        </Link>
      </div>
      <Separator />
      <div className="flex-1 overflow-y-auto px-3 py-4">
        <SidebarNav />
      </div>
      <Separator />
      <div className="flex items-center gap-2 px-3 py-3">
        <Avatar className="size-8">
          <AvatarFallback>{initialFromEmail(userEmail)}</AvatarFallback>
        </Avatar>
        <span
          className="flex-1 truncate text-xs text-muted-foreground"
          title={userEmail}
        >
          {userEmail ?? "—"}
        </span>
        <SignOutButton />
      </div>
    </div>
  );
}
