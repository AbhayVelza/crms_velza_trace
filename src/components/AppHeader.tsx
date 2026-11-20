"use client";

// Top bar beside the sidebar (DESIGN.md: one 56px frosted bar): where you are (portal › page), who is signed in,
// and the global controls (Role / User while sign-in is off, Account / Sign out otherwise, theme). The Operator's
// device status sits on a slim second row. Navigation itself lives in the Sidebar.
//
// The signed-in user chip opens a small account panel with the organisation; on narrower screens the panel also
// holds the controls that no longer fit the bar (the Role / User switcher below 1280px, the theme below 768px).
// Account and Sign out always stay in the bar.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ROLE_LABELS } from "@/lib/core/types";
import { MENU } from "@/lib/menu";
import { ActAsSwitcher, useDevUsers } from "./ActAs";
import { VelzaSymbol } from "./brand";
import { DeviceBar } from "./DeviceBar";
import { IconBuilding, IconChevronDown, IconChevronRight, IconLogOut, IconMenu, IconUser } from "./icons";
import { useSession } from "./session";
import { CollapseButton, isActive, MENU_ICONS, MenuButton } from "./Sidebar";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { cx } from "./ui";

/** "Asha Rao" → "AR" (display only). */
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function AppHeader() {
  const { role, user, organisation, logout } = useSession();
  const pathname = usePathname();
  const devUsers = useDevUsers(); // non-null while sign-in is off (development)

  const page = role ? MENU[role].find((m) => isActive(pathname, m.href)) : undefined;
  const pageLabel = page?.label ?? (pathname === "/account" ? "Account" : pathname === "/" ? "Overview" : null);
  const PageIcon = page ? MENU_ICONS[page.href] : undefined;

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/75 pt-[env(safe-area-inset-top)] backdrop-blur-xl supports-[backdrop-filter]:bg-surface/70 print:hidden">
      {/* 55px + the 1px hairline = the 56px bar (lines up with the sidebar's brand row). */}
      <div className="flex h-[3.4375rem] items-center gap-2 px-4 sm:gap-3 sm:px-6 lg:px-8">
        {/* Where you are */}
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          <MenuButton className="-ml-2 shrink-0">
            <IconMenu size={22} />
          </MenuButton>
          <CollapseButton className="-ml-1.5 shrink-0" />
          <span className="shrink-0 md:hidden">
            <VelzaSymbol height={20} />
          </span>
          {role && (
            // A plain div, not <nav>: the menu stays the page's only navigation landmark (and the only `nav a` links).
            <div className="flex min-w-0 items-center gap-1.5 border-l border-line pl-3 text-sm leading-none">
              <Link href="/" className="hidden shrink-0 text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-subtle-foreground transition-colors duration-150 hover:text-foreground sm:inline">
                {ROLE_LABELS[role]} portal
              </Link>
              {pageLabel && (
                <>
                  <IconChevronRight size={13} className="hidden shrink-0 text-subtle-foreground sm:block" />
                  {PageIcon && <PageIcon size={15} className="hidden shrink-0 text-brand sm:block" />}
                  <span className="truncate font-semibold text-foreground">{pageLabel}</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Controls */}
        {user && role && devUsers && (
          <div className="hidden shrink-0 xl:block">
            <ActAsSwitcher users={devUsers} current={{ id: user.id, role }} />
          </div>
        )}
        {role && user && (
          <AccountChip name={user.name} id={user.id} organisation={organisation} roleLabel={ROLE_LABELS[role]}>
            {devUsers && (
              <div className="xl:hidden">
                <p className="mb-2 text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-subtle-foreground">Act as (development)</p>
                <ActAsSwitcher users={devUsers} current={{ id: user.id, role }} />
              </div>
            )}
            <div className="flex items-center justify-between gap-3 md:hidden">
              <span className="text-[0.8125rem] font-medium text-foreground-2">Theme</span>
              <ThemeSwitcher />
            </div>
          </AccountChip>
        )}
        {user && !devUsers && (
          <div className="flex shrink-0 items-center gap-0.5 text-sm">
            <Link
              href="/account"
              title="Account"
              className="inline-flex h-9 min-w-9 items-center justify-center gap-2 rounded-control px-2 font-medium text-foreground-2 transition-colors duration-150 hover:bg-muted hover:text-foreground lg:px-3"
            >
              <IconUser size={16} />
              <span className="sr-only lg:not-sr-only">Account</span>
            </Link>
            <button
              type="button"
              onClick={() => void logout()}
              title="Sign out"
              className="inline-flex h-9 min-w-9 items-center justify-center gap-2 rounded-control px-2 font-semibold text-muted-foreground transition-colors duration-150 hover:bg-danger-soft hover:text-danger lg:px-3"
            >
              <IconLogOut size={16} />
              <span className="sr-only lg:not-sr-only">Sign out</span>
            </button>
          </div>
        )}
        <div className="hidden shrink-0 md:block">
          <ThemeSwitcher />
        </div>
      </div>

      {role === "OPERATOR" && (
        <div className="border-t border-line px-4 py-2 sm:px-6 lg:px-8">
          <DeviceBar />
        </div>
      )}
    </header>
  );
}

/**
 * The signed-in user as a compact pill (avatar, name, ID). It opens a small panel with the organisation and the
 * controls passed as children. Escape, a click outside or a page change closes it.
 */
function AccountChip({ name, id, organisation, roleLabel, children }: { name: string; id: string; organisation: string; roleLabel: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const pathname = usePathname();

  // A page change closes the panel (state is reset when the path it was opened on changes).
  const [openedOn, setOpenedOn] = useState(pathname);
  if (open && openedOn !== pathname) {
    setOpen(false);
    setOpenedOn(pathname);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative min-w-0 shrink">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        title={`${name} · ${organisation}`}
        onClick={() => {
          setOpenedOn(pathname);
          setOpen((o) => !o);
        }}
        className="flex min-w-0 max-w-[16rem] items-center gap-2 rounded-full border border-line bg-surface/60 py-1 pl-1 pr-2 transition-colors duration-150 hover:bg-muted"
      >
        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[0.625rem] font-bold text-foreground-2">
          {initials(name)}
        </span>
        <span className="hidden min-w-0 items-baseline gap-1.5 sm:flex">
          <span className="truncate text-xs font-semibold text-foreground" data-testid="signed-in-user">
            {name}
          </span>
          <span className="hidden shrink-0 font-mono text-[0.625rem] text-subtle-foreground lg:inline">{id}</span>
        </span>
        <span className="sr-only sm:hidden">{name}</span>
        <IconChevronDown size={14} className={cx("shrink-0 text-subtle-foreground transition-transform duration-150", open && "rotate-180")} />
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute right-0 top-full z-30 mt-2 w-[26rem] max-w-[calc(100vw-2rem)] animate-pop-in space-y-4 rounded-xl border border-line bg-surface p-4 shadow-pop"
      >
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-xs font-semibold text-background dark:bg-white/10 dark:text-foreground">
            {initials(name)}
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold text-foreground">
              {name} <span className="font-mono text-xs font-normal text-subtle-foreground">{id}</span>
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <IconBuilding size={13} className="shrink-0" />
              <span className="truncate">
                {organisation} · {roleLabel}
              </span>
            </div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
