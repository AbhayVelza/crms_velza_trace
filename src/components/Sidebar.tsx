"use client";

// Left sidebar: the role's menu (src/lib/menu.ts stays the only source of labels, hrefs and permissions).
// Desktop (lg+): 240px, collapsible to the 68px icon rail (saved in this browser, applied before first paint by
// THEME_SCRIPT). Tablet (md–lg): always the icon rail. Phone (below md): the same element slides in as a drawer
// from the header's menu button.

import { motion } from "motion/react";
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
  IconContainer,
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
  IconScanSearch,
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
  "/containers": IconContainer,
  "/details": IconScanSearch,
};

/** "Asha Rao" → "AR" (display only). */
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

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

/** Header button that opens the drawer (phones only, below md). */
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
      className={cx("inline-flex h-10 w-10 items-center justify-center rounded-control text-foreground transition-colors duration-150 hover:bg-muted md:hidden", className)}
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
      className={cx("hidden h-9 w-9 items-center justify-center rounded-control text-subtle-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground lg:inline-flex", className)}
    >
      <IconPanelLeft size={18} />
    </button>
  );
}

/** md and up: the sidebar is in the page (rail or full); below md it is the drawer. */
const WIDE_QUERY = "(min-width: 768px)";
function subscribeWide(onChange: () => void) {
  const m = window.matchMedia(WIDE_QUERY);
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}
const readWide = () => window.matchMedia(WIDE_QUERY).matches;

// ── Sidebar ──────────────────────────────────────────────────────────────────────────────────────────────

export function Sidebar() {
  const { role, user, organisation } = useSession();
  const pathname = usePathname();
  const { drawerOpen, setDrawerOpen } = useShell();
  const wide = useSyncExternalStore(subscribeWide, readWide, () => true);
  const panel = useRef<HTMLElement>(null);
  const open = drawerOpen && !wide;

  const close = useCallback(() => {
    setDrawerOpen(false);
    document.getElementById(MENU_BUTTON_ID)?.focus();
  }, [setDrawerOpen]);

  // Drawer open: Escape closes it, Tab stays inside it (the page behind is under the backdrop), the page behind
  // doesn't scroll, focus moves into it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return close();
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      const outside = !panel.current.contains(at);
      if (e.shiftKey && (at === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
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
        className={cx("fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] transition-opacity duration-300 ease-out md:hidden print:hidden", open ? "opacity-100" : "pointer-events-none opacity-0")}
      />
      <aside
        id={DRAWER_ID}
        ref={panel}
        aria-label="Sidebar"
        // Off-screen drawer links must not be reachable with Tab.
        inert={!wide && !drawerOpen}
        className={cx(
          "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-line bg-surface pb-[env(safe-area-inset-bottom)] text-foreground shadow-pop transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] dark:bg-[#161618] print:hidden",
          open ? "translate-x-0" : "-translate-x-full",
          "md:sticky md:top-0 md:z-30 md:h-screen md:w-[68px] md:max-w-none md:translate-x-0 md:shadow-none md:transition-[width] md:duration-250 lg:w-60 lg:sidebar-collapsed:w-[68px]",
        )}
      >
        {/* Brand (the existing Velza symbol). Same height as the top bar so their hairlines line up. */}
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-5 rail:justify-center rail:px-0">
          <Link href="/" onClick={() => setDrawerOpen(false)} className="flex min-w-0 items-center gap-3 rounded-md py-1" aria-label="Velza Traceability — portal home">
            <VelzaSymbol height={24} />
            <span className="min-w-0 leading-none rail:hidden">
              <span className="block text-[0.625rem] font-bold uppercase tracking-[0.08em] text-subtle-foreground">Velza</span>
              <span className="mt-0.5 block truncate text-base font-semibold tracking-[-0.01em] text-foreground">Traceability</span>
            </span>
          </Link>
          <button type="button" onClick={close} aria-label="Close menu" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground md:hidden">
            <IconX size={20} />
          </button>
        </div>

        {/* Navigation */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-4 md:overflow-visible">
          <p className="mb-2 px-3 text-[0.6875rem] font-semibold uppercase leading-4 tracking-[0.06em] text-subtle-foreground rail:sr-only">{ROLE_LABELS[role]} portal</p>
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
                        "relative isolate flex h-10 items-center gap-3 whitespace-nowrap rounded-xl px-3 text-sm transition-colors duration-200 ease-out rail:justify-center rail:px-0",
                        active ? "font-semibold text-foreground" : "font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      {/* Active anchor: a quiet neutral pill that glides to the new item when the page changes
                          (Motion layout animation); red only on the dot and the icon. */}
                      {active && (
                        <motion.span
                          layoutId="sidebar-active"
                          aria-hidden="true"
                          transition={{ type: "spring", stiffness: 420, damping: 36 }}
                          className="absolute inset-0 -z-10 rounded-xl border border-transparent bg-foreground/[0.06] dark:border-line dark:bg-white/10"
                        />
                      )}
                      <span aria-hidden="true" className={cx("h-2 w-2 shrink-0 rounded-full rail:hidden", active ? "bg-primary shadow-[0_0_6px_rgb(223_37_49/0.45)]" : "bg-transparent")} />
                      {Icon && <Icon size={18} className={cx("shrink-0 transition-colors duration-200", active ? "text-brand" : "text-subtle-foreground group-hover/item:text-foreground")} />}
                      <span className="truncate rail:sr-only">{m.label}</span>
                    </Link>
                    {/* Tooltip for the icon rail (the link keeps its accessible name above). */}
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 hidden -translate-y-1/2 translate-x-[-4px] whitespace-nowrap rounded-control bg-foreground px-2.5 py-1.5 text-xs font-semibold text-background opacity-0 shadow-pop transition-[opacity,transform] duration-150 ease-out rail:block group-hover/item:translate-x-0 group-hover/item:opacity-100 group-focus-within/item:translate-x-0 group-focus-within/item:opacity-100"
                    >
                      {m.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>

        {/* Who is signed in (display only: account and sign-out controls stay in the header). */}
        {user && (
          <div className="shrink-0 border-t border-line p-3 rail:px-2">
            <div
              className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-3 py-2.5 rail:justify-center rail:border-transparent rail:bg-transparent rail:px-0"
              title={`${user.name} · ${ROLE_LABELS[role]}`}
            >
              <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-xs font-semibold uppercase text-background dark:border dark:border-line dark:bg-white/10 dark:text-foreground">
                {initials(user.name)}
              </span>
              <span className="min-w-0 leading-tight rail:sr-only">
                <span className="block truncate text-xs font-semibold text-foreground">{user.name}</span>
                <span className="mt-0.5 block truncate text-[0.6875rem] text-muted-foreground">{organisation || ROLE_LABELS[role]}</span>
              </span>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
