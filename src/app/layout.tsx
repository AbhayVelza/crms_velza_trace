import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import localFont from "next/font/local";
import favicon from "@/components/brand-assets/velza-favicon.svg";
import { CookieNotice } from "@/components/CookieNotice";
import { THEME_SCRIPT } from "@/components/themeScript";
import "./globals.css";

// DESIGN.md typography. next/font downloads the files at build time and serves them from this app,
// so browsers never contact Google and the running app needs no internet.
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });
const jetbrainsMono = JetBrains_Mono({ subsets: ["latin"], display: "swap", variable: "--font-jetbrains-mono" });
// Open Sans stays the printed stickers' font (globals.css pins .sheet to it), so sticker text sizes don't change.
const openSans = localFont({ src: "./fonts/OpenSans-Variable.ttf", weight: "300 800", style: "normal", display: "swap", variable: "--font-open-sans" });

export const metadata: Metadata = {
  title: "Velza Traceability",
  description: "Velza barcode generation and lot traceability",
  // Transparent V that follows the browser's light/dark setting. Static import, so it is served from
  // /_next/static and stays visible to signed-out visitors; app/favicon.ico (V on white) is the fallback.
  icons: { icon: [{ url: favicon.src, type: "image/svg+xml" }] },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-theme is replaced before first paint by THEME_SCRIPT (saved choice; dark by default).
    <html lang="en" data-theme="dark" className={`${inter.variable} ${jetbrainsMono.variable} ${openSans.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        {children}
        <CookieNotice />
      </body>
    </html>
  );
}
