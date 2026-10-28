"use client";

// Manufacturer device status: Online/Offline toggle, unsynced count, Sync button.

import { useState } from "react";
import { api, errorText } from "@/lib/client";
import type { Device } from "@/lib/core/types";
import { notifyDataChanged } from "@/lib/events";
import { IconCpu, IconRefresh, IconWifi, IconWifiOff } from "./icons";
import { cx, Pill } from "./ui";
import { useApi } from "./useApi";

interface DeviceInfo extends Device {
  unsynced: { batches: number; lots: number; printOrders: number };
  reservedCodes: number;
}

export function DeviceBar() {
  const { data: devices } = useApi<DeviceInfo[]>("/api/devices", { refreshOnChange: true });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const device = devices?.[0];
  if (!device) return null;

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
      <span className="flex items-center gap-1.5 font-medium text-foreground-2">
        <IconCpu size={16} className="text-muted-foreground" />
        {device.name}
      </span>
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
