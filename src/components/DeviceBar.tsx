"use client";

// Manufacturer device status: Online/Offline toggle, unsynced count, Sync button.

import { useState } from "react";
import { api, errorText } from "@/lib/client";
import type { Device } from "@/lib/core/types";
import { notifyDataChanged } from "@/lib/events";
import { cx } from "./ui";
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
      <span className="font-medium text-slate-600">{device.name}</span>
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={!device.offline}
        className={cx("rounded-full px-3 py-1 font-semibold", device.offline ? "bg-slate-700 text-white" : "bg-green-600 text-white")}
        title="Simulate network loss for this device"
      >
        {device.offline ? "● Offline" : "● Online"}
      </button>
      <span className={cx("rounded px-2 py-1", pending ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-600")}>
        Unsynced: {device.unsynced.lots} lot{device.unsynced.lots === 1 ? "" : "s"}
      </span>
      <button
        type="button"
        onClick={sync}
        disabled={busy || device.offline}
        className="rounded-md border border-slate-300 bg-white px-3 py-1 font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
        title={device.offline ? "Switch the device Online first" : "Upload unsynced batches and lots to Velza"}
      >
        Sync
      </button>
      <span className="text-slate-500">Pool: {device.reservedCodes} codes</span>
      {msg && <span className={msg.ok ? "text-green-700" : "text-red-700"}>{msg.text}</span>}
    </div>
  );
}
