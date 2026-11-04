"use client";

// Shared scanning input (spec 6.8):
// - always-focused text box that submits on Enter (USB/Bluetooth scanners type the code + Enter)
// - "Use camera" with @zxing/browser (Code 128 + QR; QR URLs → last path segment)
// - dev-only demo helper: click-to-scan buttons for codes relevant to this screen

import { useCallback, useEffect, useRef, useState } from "react";
import type { IScannerControls } from "@zxing/browser";
import type { DecodeHintType as Hint } from "@zxing/library";
import { extractScannedCode } from "@/lib/core/codes";
import type { DemoCode, DemoScreen } from "@/lib/services/demo";
import { IconCamera, IconChevronRight, IconCircleCheck, IconCircleX, IconScan, IconX } from "./icons";
import { Button, Code, cx, Input } from "./ui";
import { useApi } from "./useApi";

export const DEMO_HELPER_ENABLED = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_DEMO_HELPER === "1";

interface Props {
  onScan: (code: string) => unknown | Promise<unknown>;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  demoScreen?: DemoScreen;
  demoLotCode?: string;
}

const OTHER_FIELDS = "input, select, textarea, [contenteditable=true]";

export function ScanInput({ onScan, label = "Scan code", placeholder = "Scan or type a code, then Enter", disabled, demoScreen, demoLotCode }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(false);

  const demoPath = DEMO_HELPER_ENABLED && demoScreen ? `/api/demo-codes?screen=${demoScreen}${demoLotCode ? `&lotCode=${encodeURIComponent(demoLotCode)}` : ""}` : null;
  const demo = useApi<DemoCode[]>(demoPath, { refreshOnChange: true });
  const reloadDemo = demo.reload;

  const submit = useCallback(
    async (raw: string) => {
      const code = extractScannedCode(raw);
      if (!code || busy) return;
      setBusy(true);
      setValue("");
      try {
        await onScan(code);
      } finally {
        setBusy(false);
        reloadDemo();
        ref.current?.focus();
      }
    },
    [busy, onScan, reloadDemo],
  );

  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);

  return (
    <div className="space-y-2">
      <label className="block text-[0.8125rem] font-semibold text-foreground-2" htmlFor="scan-input">
        {label}
      </label>
      <div className="flex flex-wrap gap-2 sm:flex-nowrap">
        <Input
          id="scan-input"
          ref={ref}
          value={value}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={placeholder}
          className="min-w-0 flex-1 basis-full font-mono text-base sm:basis-auto"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit(value);
            }
          }}
          onBlur={(e) => {
            // Stay focused for the scanner unless the user moved to another field or into the menu drawer.
            const next = e.relatedTarget as HTMLElement | null;
            if (!next?.matches(OTHER_FIELDS) && !next?.closest("#app-sidebar") && !disabled)
              setTimeout(() => !document.activeElement?.closest("#app-sidebar") && ref.current?.focus(), 0);
          }}
        />
        <Button onClick={() => submit(value)} disabled={disabled || !value.trim() || busy}>
          <IconScan size={17} />
          Scan
        </Button>
        <Button variant="secondary" onClick={() => setCamera((c) => !c)} disabled={disabled} aria-pressed={camera}>
          {camera ? <IconX size={17} /> : <IconCamera size={17} />}
          {camera ? "Close camera" : "Use camera"}
        </Button>
      </div>
      {camera && <CameraScanner onCode={submit} onClose={() => setCamera(false)} />}
      {demoPath && (
        <details className="rounded-control border border-dashed border-line-strong bg-surface-2 px-3 py-2 text-sm" open>
          <summary className="flex cursor-pointer select-none items-center gap-1.5 rounded text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground">
            <IconChevronRight size={15} className="disclosure-chevron transition-transform duration-150" />
            Demo helper (dev only): click to scan
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {demo.data?.length ? (
              demo.data.map((d) => (
                <button
                  key={d.code + d.label}
                  type="button"
                  disabled={disabled || busy}
                  onClick={() => submit(d.code)}
                  className="rounded-control border border-line-strong bg-surface px-2 py-1 text-left text-foreground transition-colors duration-150 hover:border-foreground hover:bg-muted disabled:opacity-50"
                  data-demo-code={d.code}
                >
                  <Code>{d.code}</Code> <span className="text-xs text-muted-foreground">{d.label}</span>
                </button>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">{demo.loading ? "Loading…" : "No codes for this screen right now"}</span>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function CameraScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const last = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const onCodeRef = useRef(onCode);
  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);

  useEffect(() => {
    let controls: IScannerControls | undefined;
    let stopped = false;
    (async () => {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices) {
          throw new Error("Camera needs HTTPS (or localhost). Use `next dev --experimental-https` for phones.");
        }
        const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
        const hints = new Map<Hint, unknown>([[DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE]]]);
        const reader = new BrowserMultiFormatReader(hints);
        const c = await reader.decodeFromConstraints({ video: { facingMode: "environment" } }, videoRef.current!, (result) => {
          if (!result) return;
          const text = result.getText();
          const now = Date.now();
          if (text === last.current.code && now - last.current.at < 2500) return; // same sticker still in view
          last.current = { code: text, at: now };
          onCodeRef.current(text);
        });
        if (stopped) c.stop();
        else controls = c;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      stopped = true;
      controls?.stop();
    };
  }, []);

  return (
    <div className="theme-dark animate-fade-in rounded-control border border-line-strong bg-black p-2 text-foreground">
      <video ref={videoRef} className={cx("mx-auto max-h-72 w-full rounded-md object-contain", error && "hidden")} muted playsInline />
      {error && <p className="p-3 text-sm text-danger">{error}</p>}
      <div className="mt-2 flex justify-between px-1 text-xs text-muted-foreground">
        <span>Point the camera at a barcode or QR code</span>
        <button type="button" onClick={onClose} className="rounded underline underline-offset-4 hover:text-foreground">
          Close
        </button>
      </div>
    </div>
  );
}

export interface ScanLogEntry {
  id: number;
  code: string;
  ok: boolean;
  message: string;
  at: string;
}

export function ScanLog({ entries }: { entries: ScanLogEntry[] }) {
  if (!entries.length) return null;
  return (
    <ul className="space-y-1.5" aria-live="polite" data-testid="scan-log">
      {entries.map((e) => (
        <li
          key={e.id}
          data-ok={e.ok}
          className={cx("flex animate-rise-in flex-wrap items-center gap-x-2.5 gap-y-1 rounded-control border px-3 py-2 text-sm text-foreground", e.ok ? "border-success-line bg-success-soft" : "border-danger-line bg-danger-soft")}
        >
          {e.ok ? <IconCircleCheck size={16} className="text-success" aria-label="OK" aria-hidden={false} role="img" /> : <IconCircleX size={16} className="text-danger" aria-label="Failed" aria-hidden={false} role="img" />}
          <Code>{e.code}</Code>
          <span className={cx("flex-1", e.ok ? "text-foreground" : "font-medium text-danger")}>{e.message}</span>
          <span className="text-xs text-muted-foreground tabular">{new Date(e.at).toLocaleTimeString()}</span>
        </li>
      ))}
    </ul>
  );
}
