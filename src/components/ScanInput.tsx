"use client";

// Shared scanning input (spec 6.8). Three ways in, one way out (`onScan` → the page calls its existing API):
// - USB / Bluetooth scanners in keyboard mode type the code + Enter into the always-ready box; only Enter (or the
//   Scan button) submits, so a half-typed value is never sent. Codes scanned while the previous one is still being
//   checked are queued in order, not dropped.
// - Manual entry: type the code and press Enter or Scan. The format (15 = case/tray, 17 = pack) is checked first.
// - Camera (@zxing/browser, Code 128 + QR; QR URLs → the code): Start/Stop, camera choice, torch where supported.
//   The same sticker held in view is sent once; the camera is released on Stop, on leaving the page and when the tab
//   is hidden.
// - Dev-only demo helper: click-to-scan buttons for codes relevant to this screen (never in a production build).
// The server stays authoritative: this component never changes a status itself.

import { useCallback, useEffect, useRef, useState } from "react";
import { CameraError, CameraSession, cameraErrorMessage, LOW_RES_WIDTH, zxingDecoder, type CameraInfo } from "@/lib/scan/camera";
import { ScanGate, type ScanSource } from "@/lib/scan/gate";
import { checkCodeFormat, normalizeScannedCode } from "@/lib/scan/normalize";
import type { DemoCode, DemoScreen } from "@/lib/services/demo";
import { IconCamera, IconChevronRight, IconCircleCheck, IconCircleX, IconScan, IconSun, IconX } from "./icons";
import { Button, Code, cx, Input, Select } from "./ui";
import { useApi } from "./useApi";

export const DEMO_HELPER_ENABLED = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_DEMO_HELPER === "1";

export type { ScanSource };

interface Props {
  onScan: (code: string, source: ScanSource) => unknown | Promise<unknown>;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Check the code format before sending (default on). */
  validate?: boolean;
  demoScreen?: DemoScreen;
  demoLotCode?: string;
}

const OTHER_FIELDS = "input, select, textarea, [contenteditable=true]";
const coarsePointer = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

/**
 * Whether the camera was left open. A page may re-create the scan box between steps (QC: lot → its packs);
 * the camera stays open across that instead of closing after every lot.
 */
let cameraWanted = false;

export function ScanInput({ onScan, label = "Scan code", placeholder = "Scan or type a code, then Enter", disabled, validate = true, demoScreen, demoLotCode }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [camera, setCameraState] = useState(cameraWanted);
  const setCamera = useCallback((next: boolean | ((c: boolean) => boolean)) => {
    setCameraState((c) => {
      const v = typeof next === "function" ? next(c) : next;
      cameraWanted = v;
      return v;
    });
  }, []);
  const [formatError, setFormatError] = useState<string | null>(null);
  const gate = useRef(new ScanGate());
  const queue = useRef<{ code: string; source: ScanSource }[]>([]);
  const cameraOpen = useRef(false);
  useEffect(() => {
    cameraOpen.current = camera;
  }, [camera]);

  const demoPath = DEMO_HELPER_ENABLED && demoScreen ? `/api/demo-codes?screen=${demoScreen}${demoLotCode ? `&lotCode=${encodeURIComponent(demoLotCode)}` : ""}` : null;
  const demo = useApi<DemoCode[]>(demoPath, { refreshOnChange: true });
  const reloadDemo = demo.reload;
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const run = useCallback(
    async (code: string, source: ScanSource) => {
      if (!gate.current.begin(code, source).ok) return false;
      setBusy(true);
      try {
        await onScanRef.current(code, source);
      } finally {
        gate.current.end();
        setBusy(false);
        reloadDemo();
        if (!cameraOpen.current && !coarsePointer()) ref.current?.focus();
        // Next queued scan on the next tick, so it uses the page's latest handler (state from the scan just answered).
        const next = queue.current.shift();
        if (next) setTimeout(() => void run(next.code, next.source), 0);
      }
      return true;
    },
    [reloadDemo],
  );

  /** Every way in ends here: normalise, check the format, then send (or queue behind the scan being checked). */
  const submit = useCallback(
    (raw: string, source: ScanSource) => {
      const code = normalizeScannedCode(raw);
      if (!code) return;
      if (validate) {
        const check = checkCodeFormat(code);
        if (!check.ok) {
          setFormatError(check.message);
          return;
        }
      }
      setFormatError(null);
      if (source === "camera") {
        void run(code, source); // the gate drops repeat frames and frames that arrive while busy
        return;
      }
      if (gate.current.busy || queue.current.length) {
        // A scanner gun can be faster than the server: keep the order, skip an exact repeat of what is waiting.
        if (!queue.current.some((q) => q.code === code)) queue.current.push({ code, source });
        return;
      }
      void run(code, source);
    },
    [run, validate],
  );

  useEffect(() => {
    if (!disabled && !coarsePointer()) ref.current?.focus();
  }, [disabled]);

  const send = (source: ScanSource) => {
    const raw = ref.current?.value ?? value; // the DOM value: a fast scanner can type faster than React re-renders
    setValue("");
    submit(raw, source);
  };

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
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder={placeholder}
          aria-describedby={formatError ? "scan-format-error" : undefined}
          aria-invalid={formatError ? true : undefined}
          className="min-w-0 flex-1 basis-full scroll-mt-24 scroll-mb-40 font-mono text-base sm:basis-auto"
          onChange={(e) => {
            setValue(e.target.value);
            if (formatError) setFormatError(null);
          }}
          onFocus={(e) => {
            // On phones, keep the box above the on-screen keyboard.
            if (coarsePointer()) e.currentTarget.scrollIntoView({ block: "center" });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (!e.repeat) send("keyboard");
            }
          }}
          onBlur={(e) => {
            // Stay focused for the scanner unless the user moved to another field, the menu drawer or the camera.
            const next = e.relatedTarget as HTMLElement | null;
            if (!next?.matches(OTHER_FIELDS) && !next?.closest("#app-sidebar") && !next?.closest("[data-camera-panel]") && !disabled && !cameraOpen.current && !coarsePointer())
              setTimeout(() => !document.activeElement?.closest("#app-sidebar") && !document.activeElement?.matches(OTHER_FIELDS) && ref.current?.focus(), 0);
          }}
        />
        <Button onClick={() => send("manual")} disabled={disabled || !value.trim()} loading={busy}>
          <IconScan size={17} />
          Scan
        </Button>
        <Button variant="secondary" onClick={() => setCamera((c) => !c)} disabled={disabled} aria-pressed={camera} aria-controls="scan-camera">
          {camera ? <IconX size={17} /> : <IconCamera size={17} />}
          {camera ? "Close camera" : "Use camera"}
        </Button>
      </div>
      {formatError && (
        <p id="scan-format-error" role="alert" className="text-sm font-medium text-danger">
          {formatError}
        </p>
      )}
      {camera && <CameraPanel onCode={(text) => submit(text, "camera")} busy={busy} onClose={() => setCamera(false)} />}
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
                  onClick={() => submit(d.code, "demo")}
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

function CameraPanel({ onCode, busy, onClose }: { onCode: (text: string) => void; busy: boolean; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const session = useRef<CameraSession | null>(null);
  const [state, setState] = useState<"starting" | "running" | "stopped">("starting");
  const [resolution, setResolution] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [torch, setTorch] = useState<{ supported: boolean; on: boolean }>({ supported: false, on: false });
  const onCodeRef = useRef(onCode);
  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);

  const start = useCallback(async (id?: string) => {
    const env = { isSecureContext: window.isSecureContext, mediaDevices: navigator.mediaDevices };
    // The decoder (zxing) is loaded on first use only.
    const decoder = session.current ? null : await zxingDecoder();
    if (!session.current) session.current = new CameraSession(videoRef.current!, decoder!, env, (t) => onCodeRef.current(t));
    setError(null);
    setState("starting");
    try {
      await session.current.start(id || undefined);
      if (session.current.state !== "running") return;
      setState("running");
      setResolution(session.current.resolution);
      setTorch({ supported: session.current.torchSupported, on: false });
      // Labels are only available once the user has allowed the camera.
      setCameras(await CameraSession.listCameras(env));
    } catch (e) {
      setState("stopped");
      setError(e instanceof CameraError ? e.message : cameraErrorMessage("FAILED"));
    }
  }, []);

  const stop = useCallback(() => {
    session.current?.stop();
    setState("stopped");
    setTorch({ supported: false, on: false });
  }, []);

  useEffect(() => {
    // Opening the panel starts the camera (an external device): the state set by start() mirrors the device.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void start();
    // Leaving the page (unmount) or hiding the tab releases the camera.
    const onHide = () => document.visibilityState === "hidden" && stop();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      session.current?.stop();
    };
  }, [start, stop]);

  const running = state === "running";
  return (
    <div id="scan-camera" data-camera-panel data-camera-state={state} className="theme-dark animate-fade-in rounded-control border border-line-strong bg-black p-2 text-foreground">
      <div className={cx("relative mx-auto aspect-[4/3] max-h-[60vh] w-full overflow-hidden rounded-md bg-black sm:max-h-80", (error || !running) && state !== "starting" && "hidden")}>
        <video ref={videoRef} className="h-full w-full object-cover" muted playsInline aria-label="Camera preview" />
        {/* Aiming frame: a wide box for barcodes; QR codes fit inside it too. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-[10%] top-1/2 h-[38%] -translate-y-1/2 rounded-lg border-2 border-white/85 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
        {busy && <span className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-0.5 text-xs text-white">Checking…</span>}
      </div>
      {error && (
        <p role="alert" className="p-3 text-sm text-danger" data-testid="camera-error">
          {error}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
        {running ? (
          <Button variant="secondary" className="min-h-11" onClick={stop}>
            Stop camera
          </Button>
        ) : (
          <Button className="min-h-11" onClick={() => void start(deviceId)} loading={state === "starting"}>
            <IconCamera size={17} />
            Start camera
          </Button>
        )}
        {cameras.length > 1 && (
          <Select
            aria-label="Camera"
            value={deviceId}
            wrapperClassName="inline-flex max-w-full"
            className="min-h-11 w-auto max-w-full"
            onChange={(e) => {
              setDeviceId(e.target.value);
              void start(e.target.value);
            }}
          >
            <option value="">Rear camera (default)</option>
            {cameras.map((c) => (
              <option key={c.deviceId} value={c.deviceId}>
                {c.label}
              </option>
            ))}
          </Select>
        )}
        {running && torch.supported && (
          <Button
            variant="secondary"
            className="min-h-11"
            aria-pressed={torch.on}
            onClick={async () => {
              const on = !torch.on;
              if (await session.current?.setTorch(on)) setTorch({ supported: true, on });
            }}
          >
            <IconSun size={17} />
            {torch.on ? "Torch off" : "Torch on"}
          </Button>
        )}
        <span className="flex-1 text-xs text-muted-foreground" aria-live="polite">
          <span data-testid="camera-status">
            {running ? "Point the camera at a barcode or QR code inside the frame" : state === "starting" ? "Starting the camera…" : "Camera off"}
            {running && resolution && ` · camera ${resolution.width}×${resolution.height}`}
          </span>
          {running && resolution && Math.max(resolution.width, resolution.height) < LOW_RES_WIDTH && (
            <span className="block text-warning">Low camera resolution: hold small pack stickers close and steady, or use a USB barcode scanner.</span>
          )}
        </span>
        <button type="button" onClick={onClose} className="min-h-11 rounded px-2 text-xs underline underline-offset-4 hover:text-foreground">
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
