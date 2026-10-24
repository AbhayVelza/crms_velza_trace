"use client";

// Session = selected role + user (stand-in for real login), plus reference data from /api/bootstrap.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, errorText, setApiUser } from "@/lib/client";
import type { Country, Device, Flavour, Partner, Role, Settings, User } from "@/lib/core/types";

export interface Bootstrap {
  countries: Country[];
  flavours: Flavour[];
  partners: Partner[];
  users: User[];
  devices: Device[];
  settings: Settings;
}

interface SessionValue {
  data: Bootstrap | null;
  error: string | null;
  role: Role | null;
  user: User | null;
  partner: Partner | null;
  setRole(role: Role): void;
  setUserId(id: string): void;
  refresh(): Promise<void>;
  flavourName(code: string): string;
  partnerName(id: string | null | undefined): string;
}

const SessionContext = createContext<SessionValue | null>(null);
const STORAGE_KEY = "velza.session";

function readStored(): { role?: Role; userId?: string } {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRoleState] = useState<Role | null>(null);
  const [userId, setUserIdState] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await api<Bootstrap>("/api/bootstrap"));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    const stored = readStored();
    /* eslint-disable react-hooks/set-state-in-effect -- restoring the saved session once on mount */
    if (stored.role) setRoleState(stored.role);
    if (stored.userId) setUserIdState(stored.userId);
    /* eslint-enable react-hooks/set-state-in-effect */
    void refresh();
  }, [refresh]);

  // Keep the chosen user valid for the chosen role.
  const user = useMemo(() => {
    if (!data || !role) return null;
    const candidates = data.users.filter((u) => u.role === role && u.active);
    return candidates.find((u) => u.id === userId) ?? candidates[0] ?? null;
  }, [data, role, userId]);

  useEffect(() => {
    setApiUser(user?.id ?? null);
    if (role) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ role, userId: user?.id }));
      } catch {
        /* private mode: session just won't persist */
      }
    }
  }, [role, user]);

  const value = useMemo<SessionValue>(
    () => ({
      data,
      error,
      role,
      user,
      partner: (user?.partnerId && data?.partners.find((p) => p.id === user.partnerId)) || null,
      setRole: (r) => {
        setRoleState(r);
        setUserIdState(null);
      },
      setUserId: setUserIdState,
      refresh,
      flavourName: (code) => data?.flavours.find((f) => f.code === code)?.name ?? code,
      partnerName: (id) => (id ? (data?.partners.find((p) => p.id === id)?.name ?? id) : "—"),
    }),
    [data, error, role, user, refresh],
  );

  // Set the API user synchronously too, so child effects on first render already send it.
  setApiUser(user?.id ?? null);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession must be used inside <SessionProvider>");
  return v;
}
