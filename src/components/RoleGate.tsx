"use client";

// Shows a page only to the roles whose portal it belongs to. The API enforces the same rules,
// so this is about a clear message, not security.

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ROLE_LABELS } from "@/lib/core/types";
import { COMMON_PATHS, rolesForPath } from "@/lib/menu";
import { useSession } from "./session";
import { Loading, Notice } from "./ui";

export function RoleGate({ children }: { children: ReactNode }) {
  const { data, error, role, user } = useSession();
  const pathname = usePathname();

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data || !role || !user) return <Loading />;
  if (COMMON_PATHS.includes(pathname)) return <>{children}</>;

  if (!rolesForPath(pathname).includes(role)) {
    return (
      <Notice tone="warn">
        This page is not part of the {ROLE_LABELS[role]} portal.{" "}
        <Link href="/" className="font-semibold underline">
          Go to your portal
        </Link>
      </Notice>
    );
  }
  return <>{children}</>;
}
