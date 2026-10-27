"use client";

// While sign-in is off (development): pick who to act as — a role, then a person — with no password.
// Shown in the header and on the start page; renders nothing when sign-in is on.

import { useEffect, useState } from "react";
import { api, errorText } from "@/lib/client";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/core/types";
import { Button, Notice, Select } from "./ui";

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
export function ActAsSwitcher({ users, current }: { users: DevUser[]; current: { id: string; role: Role } }) {
  const [error, setError] = useState<string | null>(null);
  const go = (id: string) => actAs(id, window.location.pathname + window.location.search).catch((e) => setError(errorText(e)));
  const roles = ROLES.filter((r) => users.some((u) => u.role === r));
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
      <label className="flex items-center gap-1">
        Role
        <Select aria-label="Role" className="min-h-8 w-auto py-1" value={current.role} onChange={(e) => go(users.find((u) => u.role === e.target.value)!.id)}>
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex items-center gap-1">
        User
        <Select aria-label="User" className="min-h-8 w-auto max-w-[18rem] py-1" value={current.id} onChange={(e) => go(e.target.value)}>
          {users
            .filter((u) => u.role === current.role)
            .map((u) => (
              <option key={u.id} value={u.id}>
                {label(u)}
              </option>
            ))}
        </Select>
      </label>
      {error && <span className="text-red-700">{error}</span>}
    </div>
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
