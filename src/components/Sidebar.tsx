"use client";

// Left sidebar: the role's menu (src/lib/menu.ts stays the only source of labels, hrefs and permissions).
// Desktop (lg+): always visible, collapsible to an icon rail (saved in this browser, applied before first paint
// by THEME_SCRIPT). Below lg: the same element slides in as a drawer from the header's menu button.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { ROLE_LABELS } from "@/lib/core/types";
import { MENU } from "@/lib/menu";
import { VelzaSymbol } from "./brand";
import {
  IconBell,
  IconBuilding,
  IconCircleSlash,
  IconClipboardList,
  IconCpu,
  IconDashboard,
  IconDatabase,
  IconFilePlus,
  IconGlobe,
  IconInbox,
  IconKey,
  IconListChecks,
  IconOctagonAlert,
  IconPackage,
  IconPackageOpen,
  IconPanelLeft,
  IconRotateCcw,
  IconScan,
  IconSearch,
  IconSliders,
  IconTruck,
  IconUsers,
  IconWarehouse,
  IconX,
  type IconProps,
} from "./icons";
import { useSession } from "./session";
import { SIDEBAR_EVENT, SIDEBAR_KEY } from "./themeScript";
import { cx } from "./ui";

/** Icon per menu destination. */
export const MENU_ICONS: Record<string, ComponentType<IconProps>> = {
  "/hq": IconDashboard,
  "/hq/search": IconSearch,
  "/hq/alerts": IconBell,
  "/hq/batches": IconPackage,
  "/hq/scans": IconScan,
  "/admin/partners": IconBuilding,
  "/admin/users": IconKey,
  "/admin/devices": IconCpu,
  "/admin/reference": IconGlobe,
  "/admin/pools": IconDatabase,
  "/admin/settings": IconSliders,
  "/operator/new": IconFilePlus,
  "/operator/orders": IconClipboardList,
  "/operator/reprint": IconRotateCcw,
  "/operator/void": IconCircleSlash,
  "/qc/verify": IconListChecks,
  "/receive": IconInbox,
  "/dispatch": IconTruck,
  "/open-lot": IconPackageOpen,
  "/stock": IconWarehouse,
  "/damaged": IconOctagonAlert,
  "/my-partners": IconUsers,
};

/** Same rule the menu has always used to mark the current page. */
export const isActive = (pathname: string, href: string) => pathname === href || (href !== "/hq" && pathname.startsWith(href + "/"));

// ── Shell state: the mobile drawer (open/closed) ─────────────────────────────────────────────────────────

const DRAWER_ID = "app-sidebar";
const MENU_BUTTON_ID = "app-menu-button";

interface Shell {
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
}
const ShellContext = createContext<Shell>({ drawerOpen: false, setDrawerOpen: () => undefined });

export function ShellProvider({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const value = useMemo(() => ({ drawerOpen, setDrawerOpen }), [drawerOpen]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export const useShell = () => useContext(ShellContext);

/** Header button that opens the drawer (below lg only). */
export function MenuButton({ className, children }: { className?: string; children: ReactNode }) {
  const { drawerOpen, setDrawerOpen } = useShell();
  return (
    <button
      id={MENU_BUTTON_ID}
      type="button"
      aria-label="Open menu"
      aria-controls={DRAWER_ID}
      aria-expanded={drawerOpen}
      onClick={() => setDrawerOpen(true)}
      className={cx("inline-flex h-10 w-10 items-center justify-center rounded-control text-foreground transition-colors duration-150 hover:bg-muted lg:hidden", className)}
    >
      {children}
    </button>
  );
}

// ── Desktop collapse (device preference) ─────────────────────────────────────────────────────────────────

function subscribeCollapsed(onChange: () => void) {
  window.addEventListener(SIDEBAR_EVENT, onChange);
  return () => window.removeEventListener(SIDEBAR_EVENT, onChange);
}
const readCollapsed = () => document.documentElement.getAttribute("data-sidebar") === "collapsed";

function setCollapsed(collapsed: boolean) {
  const root = document.documentElement;
  if (collapsed) root.setAttribute("data-sidebar", "collapsed");
  else root.removeAttribute("data-sidebar");
  try {
    if (collapsed) localStorage.setItem(SIDEBAR_KEY, "collapsed");
    else localStorage.removeItem(SIDEBAR_KEY);
  } catch {
    // Storage blocked: the sidebar still collapses for this page.
  }
  window.dispatchEvent(new Event(SIDEBAR_EVENT));
}

/** Header button that collapses the desktop sidebar to its icon rail and back (lg and up). */
export function CollapseButton({ className }: { className?: string }) {
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <button
      type="button"
      onClick={() => setCollapsed(!collapsed)}
      aria-expanded={!collapsed}
      aria-controls={DRAWER_ID}
      aria-label={label}
      title={label}
      className={cx("hidden h-10 w-10 items-center justify-center rounded-control text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground lg:inline-flex", className)}
    >
      <IconPanelLeft size={20} />
    </button>
  );
}

function subscribeDesktop(onChange: () => void) {
  const m = window.matchMedia("(min-width: 1024px)");
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}
const readDesktop = () => window.matchMedia("(min-width: 1024px)").matches;

// ── Sidebar ──────────────────────────────────────────────────────────────────────────────────────────────

export function Sidebar() {
  const { role } = useSession();
  const pathname = usePathname();
  const { drawerOpen, setDrawerOpen } = useShell();
  const desktop = useSyncExternalStore(subscribeDesktop, readDesktop, () => true);
  const panel = useRef<HTMLElement>(null);
  const open = drawerOpen && !desktop;

  const close = useCallback(() => {
    setDrawerOpen(false);
    document.getElementById(MENU_BUTTON_ID)?.focus();
  }, [setDrawerOpen]);

  // Drawer open: Escape closes it, the page behind doesn't scroll, focus moves into it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>("a, button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, close]);

  if (!role) return null;
  const items = MENU[role];

  return (
    <>
      {/* Backdrop (drawer only) */}
      <div
        aria-hidden="true"
        onClick={close}
        className={cx("fixed inset-0 z-40 bg-black/45 transition-opacity duration-200 ease-out lg:hidden print:hidden", open ? "opacity-100" : "pointer-events-none opacity-0")}
      />
      <aside
        id={DRAWER_ID}
        ref={panel}
        aria-label="Sidebar"
        // Off-screen drawer links must not be reachable with Tab.
        inert={!desktop && !drawerOpen}
        className={cx(
          "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-line bg-surface text-foreground shadow-pop transition-transform duration-200 ease-out print:hidden",
          open ? "translate-x-0" : "-translate-x-full",
          "lg:sticky lg:top-0 lg:z-30 lg:h-screen lg:w-64 lg:max-w-none lg:translate-x-0 lg:shadow-none lg:transition-[width] lg:sidebar-collapsed:w-[4.75rem]",
        )}
      >
        {/* Brand. Clear space around the V equals its height (brand book p. 20). */}
        <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-line px-5 lg:sidebar-collapsed:justify-center lg:sidebar-collapsed:px-0">
          <Link href="/" onClick={() => setDrawerOpen(false)} className="flex min-w-0 items-center gap-[26px] rounded-md py-1" aria-label="Velza Traceability — portal home">
            <VelzaSymbol height={26} />
            <span className="truncate text-[1.0625rem] font-bold tracking-[0.01em] text-foreground transition-opacity duration-150 lg:sidebar-collapsed:hidden">Traceability</span>
          </Link>
          <button type="button" onClick={close} aria-label="Close menu" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground lg:hidden">
            <IconX size={20} />
          </button>
        </div>

        {/* Navigation */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-4 lg:overflow-visible">
          <p className="mb-2 px-3 text-[0.6875rem] font-semibold uppercase leading-snug tracking-[0.14em] text-subtle-foreground lg:sidebar-collapsed:sr-only">{ROLE_LABELS[role]} portal</p>
          <nav aria-label="Main">
            <ul className="space-y-1">
              {items.map((m) => {
                const active = isActive(pathname, m.href);
                const Icon = MENU_ICONS[m.href];
                return (
                  <li key={m.href} className="group/item relative">
                    <Link
                      href={m.href}
                      // Choosing a page closes the drawer (no effect on desktop).
                      onClick={() => setDrawerOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={cx(
                        "relative flex h-11 items-center gap-3 overflow-hidden whitespace-nowrap rounded-control px-3 text-[0.9375rem] transition-[background-color,color] duration-150 ease-out lg:sidebar-collapsed:justify-center lg:sidebar-collapsed:px-0",
                        active ? "bg-muted font-semibold text-foreground" : "font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                    >
                      {/* Active indicator: a fine bar on the leading edge. */}
                      <span
                        aria-hidden="true"
                        className={cx("absolute inset-y-2.5 left-0 w-[3px] rounded-r-full bg-foreground transition-[opacity,transform] duration-200 ease-out", active ? "scale-y-100 opacity-100" : "scale-y-50 opacity-0")}
                      />
                      {Icon && <Icon size={20} className={cx("transition-colors duration-150", active ? "text-foreground" : "text-subtle-foreground group-hover/item:text-foreground")} />}
                      <span className="truncate lg:sidebar-collapsed:sr-only">{m.label}</span>
                    </Link>
                    {/* Tooltip for the collapsed icon rail (the link keeps its accessible name above). */}
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 hidden -translate-y-1/2 translate-x-[-4px] whitespace-nowrap rounded-control bg-foreground px-2.5 py-1.5 text-xs font-semibold text-background opacity-0 shadow-pop transition-[opacity,transform] duration-150 ease-out lg:sidebar-collapsed:block group-hover/item:translate-x-0 group-hover/item:opacity-100 group-focus-within/item:translate-x-0 group-focus-within/item:opacity-100"
                    >
                      {m.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>

      </aside>
    </>
  );
}
