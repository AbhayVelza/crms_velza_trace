import { SessionProvider } from "@/components/session";

export default function PrintLayout({ children }: LayoutProps<"/print">) {
  return (
    <SessionProvider>
      <main className="w-full flex-1 bg-white p-4 print:p-0">{children}</main>
    </SessionProvider>
  );
}
