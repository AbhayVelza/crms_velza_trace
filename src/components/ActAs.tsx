"use client";

// While sign-in is off (development): pick who to act as — a role, then a person — with no password.
// Shown in the header and on the start page; renders nothing when sign-in is on.

import { useEffect, useState, type ReactNode } from "react";
import { api, errorText } from "@/lib/client";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/core/types";
import { IconShield, IconUser } from "./icons";
import { Button, cx, Notice, Select } from "./ui";

export interface DevUser {
  id: string;
  name: string;
  role: Role;
  partnerId: string | null;
  partnerName: string | null;
}

/** The people who can be acted as, or null while loading / when sign-in is on. */
export function useDevUsers(): DevUser[] | null {
  const [users, setUsers] = useState<DevUser[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<DevUser[]>("/api/auth/dev-users").then(
      (u) => !cancelled && setUsers(u),
      () => undefined, // 404: sign-in is on
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return users;
}

const label = (u: DevUser) => `${u.name}${u.partnerName ? ` · ${u.partnerName}` : ""} (${u.id.length > 12 ? u.id.slice(0, 8) + "…" : u.id})`;

async function actAs(userId: string, next: string) {
  await api("/api/auth/dev-login", { body: { userId } });
  window.location.assign(next);
}

/** Compact Role + User selects for the header; switching reloads the page as that person. */
export function ActAsSwitcher({ users, current, className }: { users: DevUser[]; current: { id: string; role: Role }; className?: string }) {
  const [error, setError] = useState<string | null>(null);
  const go = (id: string) => actAs(id, window.location.pathname + window.location.search).catch((e) => setError(errorText(e)));
  const roles = ROLES.filter((r) => users.some((u) => u.role === r));
  return (
    <div className={cx("grid grid-cols-2 items-center gap-2 md:flex", className)}>
      <ActAsSelect label="Role" Icon={IconShield} width="md:w-[10.5rem] lg:w-[12rem] xl:w-[10.5rem] 2xl:w-[11.5rem]" value={current.role} onChange={(v) => go(users.find((u) => u.role === v)!.id)}>
        {roles.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </ActAsSelect>
      <ActAsSelect label="User" Icon={IconUser} width="md:w-[13rem] lg:w-[18rem] xl:w-[13rem] 2xl:w-[17rem]" value={current.id} onChange={go}>
        {users
          .filter((u) => u.role === current.role)
          .map((u) => (
            <option key={u.id} value={u.id}>
              {label(u)}
            </option>
          ))}
      </ActAsSelect>
      {error && <span className="col-span-2 text-xs text-danger">{error}</span>}
    </div>
  );
}

/** One header select: icon inside the box, the label for screen readers and as a tooltip. */
function ActAsSelect({ label, Icon, width, value, onChange, children }: { label: string; Icon: typeof IconUser; width: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <label className={cx("relative block min-w-0", width)} title={`Act as: ${label.toLowerCase()}`}>
      <span className="sr-only">{label}</span>
      <Icon size={15} className="pointer-events-none absolute left-2.5 top-1/2 z-10 -translate-y-1/2 text-muted-foreground" />
      <Select aria-label={label} wrapperClassName="relative flex w-full" className="min-h-9 w-full truncate bg-surface-2 py-1.5 pl-8 text-[0.8125rem] font-medium hover:bg-muted" value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </Select>
    </label>
  );
}

/** Start page while sign-in is off: choose a role and a person. */
export function ActAsPicker({ users, next }: { users: DevUser[]; next: string }) {
  const roles = ROLES.filter((r) => users.some((u) => u.role === r));
  const [role, setRole] = useState<Role | "">("");
  const [error, setError] = useState<string | null>(null);
  if (!users.length) return <Notice tone="warn">Nobody to act as yet: run npm run seed.</Notice>;
  return (
    <div className="space-y-3">
      {error && <Notice tone="error">{error}</Notice>}
      <Select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
        <option value="">Choose a role…</option>
        {roles.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </Select>
      {role && (
        <div className="space-y-1">
          {users
            .filter((u) => u.role === role)
            .map((u) => (
              <Button key={u.id} variant="secondary" className="w-full justify-start text-left" onClick={() => actAs(u.id, next).catch((e) => setError(errorText(e)))}>
                {label(u)}
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}
