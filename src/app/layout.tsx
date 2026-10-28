import type { Metadata } from "next";
import localFont from "next/font/local";
import favicon from "@/components/brand-assets/velza-favicon.svg";
import { THEME_SCRIPT } from "@/components/themeScript";
import "./globals.css";

// Open Sans, the brand book's UI typeface (SIL OFL, bundled so the app needs no internet).
const openSans = localFont({
  src: "./fonts/OpenSans-Variable.ttf",
  weight: "300 800",
  style: "normal",
  display: "swap",
  variable: "--font-open-sans",
});

export const metadata: Metadata = {
  title: "Velza Traceability",
  description: "Velza barcode generation and lot traceability prototype",
  // Transparent V that follows the browser's light/dark setting. Static import, so it is served from
  // /_next/static and stays visible to signed-out visitors; app/favicon.ico (V on white) is the fallback.
  icons: { icon: [{ url: favicon.src, type: "image/svg+xml" }] },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-theme is replaced before first paint by THEME_SCRIPT (saved choice or the system setting).
    <html lang="en" data-theme="light" className={`${openSans.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
