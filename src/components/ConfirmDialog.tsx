"use client";

// In-app confirmation for irreversible actions (replaces the browser's confirm box). A native modal
// <dialog>: focus stays inside it, Escape cancels, focus returns to the button that opened it. The
// confirm button shows progress, and a failure is shown inside the dialog so the person can retry or cancel.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Notice } from "./ui";

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  /** Resolves when done; throw (or reject) to keep the dialog open and show the error. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement as HTMLElement | null;
      setError(null);
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  function close() {
    if (busy) return;
    onClose();
    opener.current?.focus?.();
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setBusy(false);
      onClose();
      opener.current?.focus?.();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-body"
      onCancel={(e) => {
        e.preventDefault(); // Escape: close through our handler so focus goes back
        close();
      }}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-5 text-foreground shadow-xl backdrop:bg-black/50"
    >
      {open && (
        <>
          <h2 id="confirm-dialog-title" className="text-base font-bold">
            {title}
          </h2>
          <div id="confirm-dialog-body" className="mt-2 text-sm text-foreground-2">
            {children}
          </div>
          {error && (
            <Notice tone="error" className="mt-3">
              {error}
            </Notice>
          )}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" className="min-h-11" autoFocus onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" className="min-h-11" onClick={confirm} loading={busy}>
              {confirmLabel}
            </Button>
          </div>
        </>
      )}
    </dialog>
  );
}
