"use client";

// Session = the signed-in user (from the session cookie via /api/auth/me) plus reference data from /api/bootstrap.

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, errorText } from "@/lib/client";
import type { Country, Device, Flavour, Partner, PublicUser, Role, Settings } from "@/lib/core/types";

export interface Bootstrap {
  countries: Country[];
  flavours: Flavour[];
  partners: Partner[];
  devices: Device[];
  settings: Settings;
}

export interface Me {
  user: PublicUser;
  partner: Partner | null;
  organisation: string;
}

interface SessionValue {
  data: Bootstrap | null;
  error: string | null;
  role: Role | null;
  user: PublicUser | null;
  partner: Partner | null;
  organisation: string;
  refresh(): Promise<void>;
  logout(): Promise<void>;
  flavourName(code: string): string;
  partnerName(id: string | null | undefined): string;
}

const SessionContext = createContext<SessionValue | null>(null);

type Loaded = { ok: true; me: Me; data: Bootstrap } | { ok: false; error: string };

async function load(): Promise<Loaded> {
  try {
    // Not signed in → api() redirects to /login.
    const [me, data] = await Promise.all([api<Me>("/api/auth/me"), api<Bootstrap>("/api/bootstrap")]);
    return { ok: true, me, data };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const router = useRouter();

  const apply = useCallback((r: Loaded) => {
    if (r.ok) {
      setMe(r.me);
      setData(r.data);
      setError(null);
    } else setError(r.error);
  }, []);

  const refresh = useCallback(async () => apply(await load()), [apply]);

  useEffect(() => {
    let cancelled = false;
    load().then((r) => !cancelled && apply(r));
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const logout = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      // /login is outside this layout, so all signed-in state is dropped with it.
      router.replace("/login");
    }
  }, [router]);

  const value = useMemo<SessionValue>(
    () => ({
      data,
      error,
      role: me?.user.role ?? null,
      user: me?.user ?? null,
      partner: me?.partner ?? null,
      organisation: me?.organisation ?? "",
      refresh,
      logout,
      flavourName: (code) => data?.flavours.find((f) => f.code === code)?.name ?? code,
      partnerName: (id) => (id ? (data?.partners.find((p) => p.id === id)?.name ?? id) : "—"),
    }),
    [data, me, error, refresh, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession must be used inside <SessionProvider>");
  return v;
}
