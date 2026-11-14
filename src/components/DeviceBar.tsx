"use client";

// Manufacturer device status: Online/Offline toggle, unsynced count, Sync button.
//
// "This PC": a plant with several PCs chooses, once per browser, which PC this is. The choice is kept in this
// browser (localStorage) and sent with every print operation (print order, continuation, reprint, void, sync,
// mark as printed); the server checks the PC belongs to the plant and refuses work with no PC when the plant has
// several (DEVICE_REQUIRED). A plant with one PC needs no choice and sees the bar as before.

import { useEffect, useState, useSyncExternalStore } from "react";
import { api, errorText } from "@/lib/client";
import type { Device } from "@/lib/core/types";
import { notifyDataChanged } from "@/lib/events";
import { IconCpu, IconRefresh, IconWifi, IconWifiOff } from "./icons";
import { cx, Pill, Select } from "./ui";
import { useApi } from "./useApi";

interface DeviceInfo extends Device {
  unsynced: { batches: number; lots: number; printOrders: number };
  reservedCodes: number;
}

const THIS_PC_KEY = "velza.thisPc";
const listeners = new Set<() => void>();

function readThisPc(): string | null {
  try {
    return window.localStorage.getItem(THIS_PC_KEY);
  } catch {
    return null;
  }
}

function setThisPc(id: string | null) {
  try {
    if (id) window.localStorage.setItem(THIS_PC_KEY, id);
    else window.localStorage.removeItem(THIS_PC_KEY);
  } catch {
    // storage blocked: the choice lasts until the page is reloaded
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** The PC chosen as "This PC" in this browser, to send as `deviceId` with a print operation (undefined: none chosen). */
export function thisPcId(): string | undefined {
  return typeof window === "undefined" ? undefined : (readThisPc() ?? undefined);
}

export function DeviceBar() {
  const { data: devices } = useApi<DeviceInfo[]>("/api/devices", { refreshOnChange: true });
  const chosen = useSyncExternalStore(subscribe, readThisPc, () => null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // A PC that was removed or moved to another plant is no longer this browser's PC.
  useEffect(() => {
    if (devices && chosen && !devices.some((d) => d.id === chosen)) setThisPc(null);
  }, [devices, chosen]);

  if (!devices?.length) return null;
  const several = devices.length > 1;
  const device = devices.find((d) => d.id === chosen) ?? (several ? undefined : devices[0]);

  const picker = several && (
    <Select
      aria-label="This PC"
      value={device?.id ?? ""}
      onChange={(e) => (setThisPc(e.target.value || null), setMsg(null))}
      className="min-h-8 py-0 text-xs"
      title="Which plant PC is this? Print orders, reprints, voids and sync are recorded on it."
    >
      <option value="">Choose this PC…</option>
      {devices.map((d) => (
        <option key={d.id} value={d.id}>
          This PC: {d.name}
        </option>
      ))}
    </Select>
  );

  if (!device) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="device-bar">
        <IconCpu size={16} className="text-muted-foreground" />
        {picker}
        <Pill tone="warn">Choose this PC before printing</Pill>
      </div>
    );
  }

  async function toggle() {
    if (!device) return;
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/devices/${device.id}`, { method: "PATCH", body: { offline: !device.offline } });
      notifyDataChanged();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    if (!device) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ message: string }>("/api/sync", { body: { deviceId: device.id } });
      setMsg({ ok: true, text: r.message });
      notifyDataChanged();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const pending = device.unsynced.lots + device.unsynced.batches;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="device-bar">
      {picker || (
        <span className="flex items-center gap-1.5 font-medium text-foreground-2">
          <IconCpu size={16} className="text-muted-foreground" />
          {device.name}
        </span>
      )}
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={!device.offline}
        className={cx(
          "inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 font-semibold transition-colors duration-150 disabled:opacity-60",
          device.offline ? "border-line-strong bg-muted text-foreground hover:bg-muted-strong" : "border-success-line bg-success-soft text-success hover:brightness-110",
        )}
        title="Simulate network loss for this device"
      >
        {device.offline ? <IconWifiOff size={15} /> : <IconWifi size={15} />}
        {device.offline ? "Offline" : "Online"}
      </button>
      <Pill tone={pending ? "warn" : "neutral"}>
        Unsynced: {device.unsynced.lots} lot{device.unsynced.lots === 1 ? "" : "s"}
      </Pill>
      <button
        type="button"
        onClick={sync}
        disabled={busy || device.offline}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 font-semibold text-foreground transition-colors duration-150 hover:bg-muted disabled:cursor-not-allowed disabled:text-subtle-foreground disabled:hover:bg-surface"
        title={device.offline ? "Switch the device Online first" : "Upload unsynced batches and lots to Velza"}
      >
        <IconRefresh size={15} className={busy ? "animate-spin" : undefined} />
        Sync
      </button>
      <span className="text-muted-foreground">Pool: {device.reservedCodes} codes</span>
      {msg && <span className={msg.ok ? "text-success" : "text-danger"}>{msg.text}</span>}
    </div>
  );
}
