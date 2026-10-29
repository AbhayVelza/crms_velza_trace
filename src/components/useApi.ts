"use client";

// Load JSON from an API route; reloads when the path, the selected user, or reload() changes.

import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "@/lib/client";
import { onDataChanged } from "@/lib/events";
import { useSession } from "./session";

export interface ApiState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  /** A reload is in flight while the previous data is still shown (the page stays as it is). */
  refreshing: boolean;
  reload: () => void;
}

export function useApi<T>(path: string | null, opts: { refreshOnChange?: boolean } = {}): ApiState<T> {
  const { user } = useSession();
  const userId = user?.id ?? null;
  const [state, setState] = useState<{ data?: T; error: string | null; loading: boolean; key: string; tick: number }>({ error: null, loading: true, key: "", tick: -1 });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!path || !userId) return;
    let cancelled = false;
    const key = `${path}|${userId}`;
    api<T>(path).then(
      (data) => !cancelled && setState({ data, error: null, loading: false, key, tick }),
      (e) => !cancelled && setState((s) => ({ ...s, error: errorText(e), loading: false, key, tick })),
    );
    return () => {
      cancelled = true;
    };
  }, [path, userId, tick]);

  const { refreshOnChange } = opts;
  useEffect(() => (refreshOnChange ? onDataChanged(reload) : undefined), [refreshOnChange, reload]);

  const fresh = state.key === `${path}|${userId}`;
  // Never show data that belongs to a previous path or user.
  return {
    data: fresh ? state.data : undefined,
    error: fresh ? state.error : null,
    loading: !fresh || state.loading,
    refreshing: fresh && state.tick !== tick,
    reload,
  };
}
