"use client";

// Shows the page only when a role/user is selected and the page belongs to that role.

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ROLE_LABELS } from "@/lib/core/types";
import { rolesForPath } from "@/lib/menu";
import { useSession } from "./session";
import { Notice } from "./ui";

export function RoleGate({ children }: { children: ReactNode }) {
  const { data, error, role, user, setRole } = useSession();
  const pathname = usePathname();

  if (error) return <Notice tone="error">Could not load reference data: {error}</Notice>;
  if (!data) return <p className="text-sm text-slate-500">Loading…</p>;
  if (pathname === "/") return <>{children}</>;

  const allowed = rolesForPath(pathname);
  if (!role || !user) {
    return <Notice tone="info">Choose a role and user in the header to start.</Notice>;
  }
  if (allowed.length && !allowed.includes(role)) {
    return (
      <Notice tone="warn">
        This screen is for {allowed.map((r) => ROLE_LABELS[r]).join(" / ")}. You are signed in as {ROLE_LABELS[role]}.{" "}
        <button type="button" className="font-semibold underline" onClick={() => setRole(allowed[0])}>
          Switch to {ROLE_LABELS[allowed[0]]}
        </button>
      </Notice>
    );
  }
  return <>{children}</>;
}
