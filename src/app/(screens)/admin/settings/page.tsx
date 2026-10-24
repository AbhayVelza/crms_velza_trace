"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/components/session";
import { Button, Card, Field, Input, Notice, PageTitle, Select } from "@/components/ui";
import { api, errorText } from "@/lib/client";
import type { Settings } from "@/lib/core/types";

export default function SettingsPage() {
  const { data, refresh } = useSession();
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    api<Settings>("/api/admin/settings").then(setS, (e) => setMsg({ tone: "error", text: errorText(e) }));
  }, []);

  if (!s) return msg ? <Notice tone="error">{msg.text}</Notice> : <p className="text-sm text-slate-500">Loading…</p>;

  const num = (v: string) => (v === "" ? NaN : Number(v));
  const size = (k: "lotSticker" | "packSticker", dim: "widthMm" | "heightMm", v: string) => setS({ ...s, [k]: { ...s[k], [dim]: num(v) } });

  async function save() {
    setMsg(null);
    try {
      const { id: _id, ...patch } = s!;
      void _id;
      setS(await api<Settings>("/api/admin/settings", { method: "PUT", body: patch }));
      setMsg({ tone: "ok", text: "Settings saved" });
      await refresh();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  }

  return (
    <>
      <PageTitle title="Settings" />
      {msg && <Notice tone={msg.tone} className="mb-4">{msg.text}</Notice>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="NOT_RECEIVED alert">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Threshold (days)" hint="Lots in transit longer than this raise an alert">
              <Input type="number" step="0.5" min="0.01" value={s.notReceivedThresholdDays} onChange={(e) => setS({ ...s, notReceivedThresholdDays: num(e.target.value) })} />
            </Field>
            <Field label="Demo mode" hint="Use minutes instead of days">
              <label className="flex min-h-10 items-center gap-2">
                <input type="checkbox" className="h-5 w-5 accent-teal-700" checked={s.demoMode} onChange={(e) => setS({ ...s, demoMode: e.target.checked })} />
                {s.demoMode ? "On" : "Off"}
              </label>
            </Field>
            <Field label="Demo threshold (minutes)">
              <Input type="number" min="1" value={s.demoThresholdMinutes} onChange={(e) => setS({ ...s, demoThresholdMinutes: num(e.target.value) })} />
            </Field>
          </div>
        </Card>
        <Card title="Stickers (mm)">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Lot sticker width">
              <Input type="number" value={s.lotSticker.widthMm} onChange={(e) => size("lotSticker", "widthMm", e.target.value)} />
            </Field>
            <Field label="Lot sticker height">
              <Input type="number" value={s.lotSticker.heightMm} onChange={(e) => size("lotSticker", "heightMm", e.target.value)} />
            </Field>
            <Field label="Pack sticker width">
              <Input type="number" value={s.packSticker.widthMm} onChange={(e) => size("packSticker", "widthMm", e.target.value)} />
            </Field>
            <Field label="Pack sticker height">
              <Input type="number" value={s.packSticker.heightMm} onChange={(e) => size("packSticker", "heightMm", e.target.value)} />
            </Field>
          </div>
        </Card>
        <Card title="QR code">
          <Field label="Public base URL" hint={`QR encodes ${s.publicBaseUrl.replace(/\/+$/, "")}/t/<lot code>`}>
            <Input value={s.publicBaseUrl} onChange={(e) => setS({ ...s, publicBaseUrl: e.target.value })} />
          </Field>
        </Card>
        <Card title="Batch codes">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Issue size">
              <Input type="number" min="1" max="100" value={s.poolIssueSize} onChange={(e) => setS({ ...s, poolIssueSize: num(e.target.value) })} />
            </Field>
            <Field label="Refill below">
              <Input type="number" min="0" value={s.poolRefillBelow} onChange={(e) => setS({ ...s, poolRefillBelow: num(e.target.value) })} />
            </Field>
            <Field label="Country for new batches">
              <Select value={s.defaultCountry} onChange={(e) => setS({ ...s, defaultCountry: e.target.value })}>
                {data?.countries.filter((c) => c.active).map((c) => (
                  <option key={c.id} value={c.code}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
      </div>
      <Button className="mt-4" onClick={save}>
        Save settings
      </Button>
    </>
  );
}
