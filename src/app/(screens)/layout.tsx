import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { PageFade } from "@/components/PageFade";
import { RoleGate } from "@/components/RoleGate";
import { SessionProvider } from "@/components/session";
import { ShellProvider, Sidebar } from "@/components/Sidebar";
import { Loading } from "@/components/ui";

// Sidebar (left) + header and page (right). The sidebar, header and role gate read the URL (usePathname).
// On a page with an ID in its URL (/operator/orders/<id>) that is only known at request time, so they sit in
// Suspense boundaries.
export default function ScreensLayout({ children }: LayoutProps<"/">) {
  return (
    <SessionProvider>
      <ShellProvider>
        <div className="flex min-h-screen flex-1">
          <Suspense fallback={<div className="hidden w-64 shrink-0 border-r border-line bg-surface lg:block lg:sidebar-collapsed:w-[4.75rem] print:hidden" />}>
            <Sidebar />
          </Suspense>
          <div className="flex min-w-0 flex-1 flex-col">
            <Suspense fallback={<div className="h-16 border-b border-line bg-surface print:hidden" />}>
              <AppHeader />
            </Suspense>
            <main className="mx-auto w-full max-w-app flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-8 xl:px-9">
              <Suspense fallback={<Loading />}>
                <RoleGate>
                  <PageFade>{children}</PageFade>
                </RoleGate>
              </Suspense>
            </main>
          </div>
        </div>
      </ShellProvider>
    </SessionProvider>
  );
}
