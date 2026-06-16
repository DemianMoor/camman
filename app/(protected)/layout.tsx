import { requireOrgMembership } from "@/lib/auth/helpers";
import { AuthProvider } from "@/components/protected/auth-context";
import { MobileSidebar } from "@/components/protected/mobile-sidebar";
import { Sidebar } from "@/components/protected/sidebar";
import { SendStateStrip } from "@/components/sends/send-state-strip";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = await requireOrgMembership();

  return (
    <AuthProvider>
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
                any latched provider breaker are never off-screen. */}
            <div className="flex flex-1 items-center justify-end">
              <SendStateStrip />
            </div>
          </header>
          <main className="flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
        </div>
      </div>
    </AuthProvider>
  );
}
