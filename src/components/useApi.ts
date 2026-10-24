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
  reload: () => void;
}

export function useApi<T>(path: string | null, opts: { refreshOnChange?: boolean } = {}): ApiState<T> {
  const { user } = useSession();
  const userId = user?.id ?? null;
  const [state, setState] = useState<{ data?: T; error: string | null; loading: boolean; key: string }>({ error: null, loading: true, key: "" });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!path || !userId) return;
    let cancelled = false;
    const key = `${path}|${userId}`;
    api<T>(path).then(
      (data) => !cancelled && setState({ data, error: null, loading: false, key }),
      (e) => !cancelled && setState((s) => ({ ...s, error: errorText(e), loading: false, key })),
    );
    return () => {
      cancelled = true;
    };
  }, [path, userId, tick]);

  const { refreshOnChange } = opts;
  useEffect(() => (refreshOnChange ? onDataChanged(reload) : undefined), [refreshOnChange, reload]);

  const fresh = state.key === `${path}|${userId}`;
  return { data: state.data, error: state.error, loading: !fresh || state.loading, reload };
}
