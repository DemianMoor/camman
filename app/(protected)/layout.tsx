import { Suspense } from "react";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { organizations } from "@/db/schema";
import { requireOrgMembership } from "@/lib/auth/helpers";
import { isRole } from "@/lib/permissions";
import {
  AuthProvider,
  type AuthMe,
} from "@/components/protected/auth-context";
import { MobileSidebar } from "@/components/protected/mobile-sidebar";
import { Sidebar } from "@/components/protected/sidebar";
import { SendStateStripLoader } from "@/components/sends/send-state-strip-loader";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, membership } = await requireOrgMembership();

  // Hydrate the client auth context from the server (we already resolved the
  // user + membership above) so <AuthProvider> doesn't re-fetch /api/me on
  // mount. The org name is the one extra field /api/me carries; fetch it here.
  // If the role is somehow invalid, leave `initial` undefined and let the
  // client /api/me path surface the error exactly as before.
  let initialAuth: AuthMe | undefined;
  if (isRole(membership.role)) {
    const orgRows = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, membership.org_id))
      .limit(1);
    const org = orgRows[0];
    if (org) {
      initialAuth = {
        user: { id: user.id, email: user.email ?? null },
        org: { id: org.id, name: org.name, role: membership.role },
      };
    }
  }

  return (
    <AuthProvider initial={initialAuth}>
      <div className="flex min-h-screen">
        <aside className="hidden w-[248px] shrink-0 border-r bg-muted/40 md:flex">
          <Sidebar userEmail={user.email} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 items-center gap-3 border-b px-4 md:px-6">
            <MobileSidebar>
              <Sidebar userEmail={user.email} />
            </MobileSidebar>
            {/* WS4 §B3: app-level send-state strip — the global master switch and
                any latched provider breaker are never off-screen. Server-rendered
                and streamed via Suspense so it never blocks the page shell. */}
            <div className="flex flex-1 items-center justify-end">
              <Suspense fallback={null}>
                <SendStateStripLoader orgId={membership.org_id} />
              </Suspense>
            </div>
          </header>
          <main className="flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
        </div>
      </div>
    </AuthProvider>
  );
}
