import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { PageFade } from "@/components/PageFade";
import { RoleGate } from "@/components/RoleGate";
import { MotionProvider } from "@/components/motion";
import { SessionProvider } from "@/components/session";
import { ShellProvider, Sidebar } from "@/components/Sidebar";
import { Loading } from "@/components/ui";

// Sidebar (left) + header and page (right). The sidebar, header and role gate read the URL (usePathname).
// On a page with an ID in its URL (/operator/orders/<id>) that is only known at request time, so they sit in
// Suspense boundaries.
export default function ScreensLayout({ children }: LayoutProps<"/">) {
  return (
    <MotionProvider>
    <SessionProvider>
      <ShellProvider>
        <div className="flex min-h-screen flex-1">
          <Suspense fallback={<div className="hidden w-[68px] shrink-0 border-r border-line bg-surface dark:bg-[#161618] md:block lg:w-60 lg:sidebar-collapsed:w-[68px] print:hidden" />}>
            <Sidebar />
          </Suspense>
          <div className="flex min-w-0 flex-1 flex-col">
            <Suspense fallback={<div className="h-14 border-b border-line bg-background/80 print:hidden" />}>
              <AppHeader />
            </Suspense>
            <main className="mx-auto w-full max-w-app flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
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
    </MotionProvider>
  );
}
