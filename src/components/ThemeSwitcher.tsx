"use client";

// Light / Dark / System. The choice is a device preference (localStorage), applied to <html data-theme>
// by THEME_SCRIPT, so switching changes no React state, no data and makes no API call.

import { useSyncExternalStore } from "react";
import { IconMonitor, IconMoon, IconSun } from "./icons";
import { THEME_EVENT, THEME_KEY, type ThemeChoice } from "./themeScript";
import { cx } from "./ui";

function read(): ThemeChoice {
  try {
    const c = localStorage.getItem(THEME_KEY);
    return c === "light" || c === "dark" ? c : "system";
  } catch {
    return "system";
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(THEME_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function choose(c: ThemeChoice) {
  try {
    if (c === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, c);
  } catch {
    // Storage blocked (private mode): the theme still changes for this page.
  }
  const root = document.documentElement;
  root.classList.add("theme-switching");
  window.dispatchEvent(new Event(THEME_EVENT));
  if (c !== "system") root.setAttribute("data-theme", c);
  window.setTimeout(() => root.classList.remove("theme-switching"), 220);
}

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof IconSun }[] = [
  { value: "light", label: "Light theme", Icon: IconSun },
  { value: "dark", label: "Dark theme", Icon: IconMoon },
  { value: "system", label: "System theme", Icon: IconMonitor },
];

export function ThemeSwitcher({ className }: { className?: string }) {
  // null while server-rendering / hydrating: no option is marked until the saved choice is known.
  const current = useSyncExternalStore(subscribe, read, () => null);
  return (
    <div role="radiogroup" aria-label="Theme" className={cx("inline-flex items-center gap-0.5 rounded-full border border-line-strong bg-surface-2 p-[3px]", className)}>
      {OPTIONS.map(({ value, label, Icon }) => {
        const on = current === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={label}
            title={label}
            onClick={() => choose(value)}
            className={cx(
              "inline-flex h-8 w-8 items-center justify-center rounded-full transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-95",
              on ? "bg-primary text-primary-foreground shadow-card" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon size={17} />
          </button>
        );
      })}
    </div>
  );
}
