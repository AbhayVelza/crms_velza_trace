"use client";

// Run an async action (a save, a submit) at most once at a time: a second click while it is in flight is ignored,
// and `busy` drives the button's spinner (<Button loading={busy}>). The action itself — its request, payload and
// error handling — is unchanged; this only stops accidental double submits.

import { useCallback, useLayoutEffect, useRef, useState } from "react";

export function useAction<A extends unknown[]>(action: (...args: A) => Promise<unknown> | unknown): [busy: boolean, run: (...args: A) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const latest = useRef(action);
  useLayoutEffect(() => {
    latest.current = action;
  });

  const run = useCallback(async (...args: A) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await latest.current(...args);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  return [busy, run];
}
