"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/core/types";
import { MENU } from "@/lib/menu";
import { DeviceBar } from "./DeviceBar";
import { useSession } from "./session";
import { cx } from "./ui";

export function AppHeader() {
  const { data, role, user, partner, setRole, setUserId } = useSession();
  const pathname = usePathname();
  const users = data && role ? data.users.filter((u) => u.role === role && u.active) : [];

  return (
    <header className="border-b border-slate-200 bg-white print:hidden">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="mr-2 flex items-center gap-2 font-semibold text-teal-800">
          <span className="inline-block h-6 w-6 rounded bg-teal-700 text-center text-sm leading-6 text-white">V</span>
          Velza Traceability
        </Link>
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-slate-500">
            Role
            <select
              aria-label="Role"
              value={role ?? ""}
              onChange={(e) => setRole(e.target.value as Role)}
              className="min-h-9 rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900"
            >
              <option value="" disabled>
                Choose a role…
              </option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          {role && (
            <label className="flex items-center gap-1 text-xs text-slate-500">
              User
              <select
                aria-label="User"
                value={user?.id ?? ""}
                onChange={(e) => setUserId(e.target.value)}
                className="min-h-9 max-w-[16rem] rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900"
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {partner && <span className="truncate text-xs text-slate-500">@ {partner.name}</span>}
        </div>
        {role === "OPERATOR" && <DeviceBar />}
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
