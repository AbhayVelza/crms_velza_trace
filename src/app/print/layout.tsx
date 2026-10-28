import { SessionProvider } from "@/components/session";

export default function PrintLayout({ children }: LayoutProps<"/print">) {
  return (
    <SessionProvider>
      {/* Sticker preview = paper: always the light theme, whatever the app theme is. */}
      <main className="theme-light w-full flex-1 bg-surface p-4 text-foreground print:p-0 sm:p-6">{children}</main>
    </SessionProvider>
  );
}
