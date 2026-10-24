import { AppHeader } from "@/components/AppHeader";
import { RoleGate } from "@/components/RoleGate";
import { SessionProvider } from "@/components/session";

export default function ScreensLayout({ children }: LayoutProps<"/">) {
  return (
    <SessionProvider>
      <AppHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-5">
        <RoleGate>{children}</RoleGate>
      </main>
    </SessionProvider>
  );
}
