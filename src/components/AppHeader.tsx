"use client";

// Top bar beside the sidebar: where you are (portal › page), who is signed in, and the global controls
// (Role / User while sign-in is off, Account / Sign out otherwise, theme). The Operator's device status sits
// on a slim second row. Navigation itself lives in the Sidebar.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ROLE_LABELS } from "@/lib/core/types";
import { MENU } from "@/lib/menu";
import { ActAsSwitcher, useDevUsers } from "./ActAs";
import { VelzaSymbol } from "./brand";
import { DeviceBar } from "./DeviceBar";
import { IconBuilding, IconChevronRight, IconLogOut, IconMenu, IconUser } from "./icons";
import { useSession } from "./session";
import { CollapseButton, isActive, MENU_ICONS, MenuButton } from "./Sidebar";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { cx } from "./ui";

export function AppHeader() {
  const { role, user, organisation, logout } = useSession();
  const pathname = usePathname();
  const devUsers = useDevUsers(); // non-null while sign-in is off (development)

  const page = role ? MENU[role].find((m) => isActive(pathname, m.href)) : undefined;
  const pageLabel = page?.label ?? (pathname === "/account" ? "Account" : pathname === "/" ? "Overview" : null);
  const PageIcon = page ? MENU_ICONS[page.href] : undefined;

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur-md supports-[backdrop-filter]:bg-surface/80 print:hidden">
      <div className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-6 lg:px-8 xl:flex-nowrap xl:gap-x-5 xl:py-2 xl:px-9">
        {/* Where you are */}
        <div className="order-1 flex min-w-0 items-center gap-3 xl:min-w-[14rem]">
          <MenuButton className="-ml-2">
            <IconMenu size={22} />
          </MenuButton>
          <CollapseButton className="-ml-2" />
          <span className="lg:hidden">
            <VelzaSymbol height={20} />
          </span>
          {role && (
            <div className="min-w-0 border-l border-line pl-3 leading-tight lg:pl-4">
              <Link href="/" className="block truncate text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-subtle-foreground transition-colors duration-150 hover:text-foreground">
                {ROLE_LABELS[role]} portal
              </Link>
              {pageLabel && (
                <div className="mt-0.5 flex items-center gap-1.5 truncate text-base font-bold text-foreground">
                  <IconChevronRight size={14} className="hidden text-subtle-foreground sm:block" />
                  {PageIcon && <PageIcon size={17} className="hidden text-muted-foreground sm:block" />}
                  <span className="truncate">{pageLabel}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div aria-hidden="true" className="hidden flex-1 xl:order-2 xl:block" />

        {/* Who is signed in (IDs and organisation in quieter type). While sign-in is off the User select
            repeats it, so it gives way on mid-size screens. Below xl the header takes two rows: page and theme, then
            the controls. */}
        {role && user && (
          <div
            className={cx(
              "order-3 min-w-0 basis-full items-center gap-x-2 text-xs text-muted-foreground xl:basis-auto xl:flex-col xl:items-start xl:gap-y-0.5",
              devUsers ? "flex lg:hidden xl:flex" : "flex",
            )}
          >
            <span className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden">
              <IconUser size={15} className="shrink-0 text-subtle-foreground" />
              <span className="truncate text-sm font-semibold text-foreground" data-testid="signed-in-user">
                {user.name}
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{user.id}</span>
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="xl:hidden" aria-hidden="true">
                ·
              </span>
              <IconBuilding size={15} className="hidden shrink-0 text-subtle-foreground xl:block" />
              <span className="truncate">{organisation}</span>
            </span>
          </div>
        )}

        {/* Controls */}
        {user && role && devUsers && (
          <ActAsSwitcher users={devUsers} current={{ id: user.id, role }} className="order-4 basis-full xl:basis-auto xl:border-l xl:border-line xl:pl-5" />
        )}
        {user && !devUsers && (
          <div className="order-4 flex items-center gap-1 text-sm xl:border-l xl:border-line xl:pl-4">
            <Link href="/account" className="inline-flex min-h-9 items-center gap-2 rounded-full px-3 font-medium text-foreground-2 transition-colors duration-150 hover:bg-muted hover:text-foreground">
              <IconUser size={16} />
              Account
            </Link>
            <button type="button" onClick={() => void logout()} className="inline-flex min-h-9 items-center gap-2 rounded-full px-3 font-semibold text-danger transition-colors duration-150 hover:bg-danger-soft">
              <IconLogOut size={16} />
              Sign out
            </button>
          </div>
        )}
        <ThemeSwitcher className="order-2 ml-auto shrink-0 xl:order-5 xl:ml-0" />
      </div>

      {role === "OPERATOR" && (
        <div className="border-t border-line px-4 py-2 sm:px-6 lg:px-8 xl:px-9">
          <DeviceBar />
        </div>
      )}
    </header>
  );
}
