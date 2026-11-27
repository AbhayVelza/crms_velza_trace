"use client";

// A one-time notice, not a consent banner: the app sets only the strictly necessary session cookie and keeps a
// few preferences in browser storage (see /cookies), so there is nothing to accept or refuse. If an optional
// cookie (analytics, embeds) is ever added, replace this with a real choice that blocks it until accepted.

import { useSyncExternalStore } from "react";
import { COOKIE_NOTICE_KEY, LEGAL } from "@/lib/legal";

const EVENT = "velza-cookie-notice";

function seen(): boolean {
  try {
    // Shown again when the policy version changes.
    return localStorage.getItem(COOKIE_NOTICE_KEY) === LEGAL.version;
  } catch {
    return true; // storage blocked: don't nag on every page
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function dismiss() {
  try {
    localStorage.setItem(COOKIE_NOTICE_KEY, LEGAL.version);
  } catch {}
  window.dispatchEvent(new Event(EVENT));
}

export function CookieNotice() {
  // Server render: treated as seen, so the notice never flashes before hydration.
  const hidden = useSyncExternalStore(subscribe, seen, () => true);
  if (hidden) return null;

  return (
    <section
      aria-label="Cookie notice"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-2xl flex-col gap-3 rounded-card border border-line bg-surface p-4 text-sm text-foreground shadow-pop sm:flex-row sm:items-center print:hidden"
    >
      <p className="flex-1">
        We use one cookie, only to keep you signed in, and no tracking.{" "}
        <a href="/cookies" className="font-semibold underline underline-offset-2">
          Cookie notice
        </a>
      </p>
      <button
        type="button"
        onClick={dismiss}
        className="rounded-control bg-primary px-4 py-2 font-semibold text-primary-foreground hover:bg-primary-hover"
      >
        OK, got it
      </button>
    </section>
  );
}
