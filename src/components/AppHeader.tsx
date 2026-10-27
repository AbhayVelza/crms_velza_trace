"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ROLE_LABELS } from "@/lib/core/types";
import { MENU } from "@/lib/menu";
import { ActAsSwitcher, useDevUsers } from "./ActAs";
import { DeviceBar } from "./DeviceBar";
import { useSession } from "./session";
import { cx } from "./ui";

export function AppHeader() {
  const { role, user, organisation, logout } = useSession();
  const pathname = usePathname();
  const devUsers = useDevUsers(); // non-null while sign-in is off (development)

  return (
    <header className="border-b border-slate-200 bg-white print:hidden">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="mr-2 flex items-center gap-2 font-semibold text-teal-800">
          <span className="inline-block h-6 w-6 rounded bg-teal-700 text-center text-sm leading-6 text-white">V</span>
          Velza Traceability
        </Link>
        {role && user && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="rounded bg-teal-50 px-2 py-0.5 text-xs font-semibold text-teal-800">{ROLE_LABELS[role]} portal</span>
            <span className="truncate text-slate-700" data-testid="signed-in-user">
              {user.name}
            </span>
            <span className="font-mono text-xs text-slate-500">{user.id}</span>
            <span className="truncate text-xs text-slate-500">@ {organisation}</span>
          </div>
        )}
        {role === "OPERATOR" && <DeviceBar />}
        {user && role && devUsers && <ActAsSwitcher users={devUsers} current={{ id: user.id, role }} />}
        {user && !devUsers && (
          <div className="flex items-center gap-1 text-sm">
            <Link href="/account" className="rounded-md px-2 py-1.5 text-slate-700 hover:bg-slate-100">
              Account
            </Link>
            <button type="button" onClick={() => void logout()} className="rounded-md px-2 py-1.5 font-medium text-red-700 hover:bg-red-50">
              Sign out
            </button>
          </div>
        )}
      </div>
      {role && (
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-2 text-sm">
          {MENU[role].map((m) => {
            const active = pathname === m.href || (m.href !== "/hq" && pathname.startsWith(m.href + "/"));
            return (
              <Link
                key={m.href}
                href={m.href}
                className={cx("whitespace-nowrap rounded-md px-3 py-1.5", active ? "bg-teal-700 text-white" : "text-slate-700 hover:bg-slate-100")}
              >
                {m.label}
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
