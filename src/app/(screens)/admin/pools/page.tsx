"use client";

import { useState } from "react";
import { useApi } from "@/components/useApi";
import { Button, Card, Code, Empty, fmtTime, Input, Notice, PageTitle, StatusBadge, Table, Td } from "@/components/ui";
import { api, errorText } from "@/lib/client";
import type { BatchCodePoolEntry, Device } from "@/lib/core/types";

interface PoolView {
  settings: { poolIssueSize: number; poolRefillBelow: number };
  devices: { device: Device; manufacturer: string; reserved: number; used: number; codes: BatchCodePoolEntry[] }[];
}

export default function PoolsPage() {
  const { data: view, error, reload } = useApi<PoolView>("/api/admin/pools");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function issue(deviceId: string) {
    setMsg(null);
    try {
      const n = Number(counts[deviceId] || view?.settings.poolIssueSize || 10);
      const r = await api<{ issued: BatchCodePoolEntry[]; reserved: number }>("/api/admin/pools", { body: { deviceId, count: n } });
      setMsg({ tone: "ok", text: `Issued ${r.issued.length} codes: ${r.issued.map((c) => c.code).join(", ")}` });
      reload();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  }

  return (
    <>
      <PageTitle
        title="Batch code pools"
        subtitle={
          view
            ? `Each device gets random batch codes in advance so it can work offline. Auto-refill: ${view.settings.poolIssueSize} codes when fewer than ${view.settings.poolRefillBelow} remain and the device is online.`
            : undefined
        }
      />
      {msg && <Notice tone={msg.tone} className="mb-4">{msg.text}</Notice>}
      {error && <Notice tone="error" className="mb-4">{error}</Notice>}
      <div className="space-y-4">
        {view?.devices.map(({ device, manufacturer, reserved, used, codes }) => (
          <Card
            key={device.id}
            title={
              <span>
                {device.name} <span className="font-normal text-slate-500">· {manufacturer}</span>{" "}
                <span className={device.offline ? "text-slate-700" : "text-green-700"}>{device.offline ? "● Offline" : "● Online"}</span>
              </span>
            }
            actions={
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  aria-label="Codes to issue"
                  className="w-24"
                  value={counts[device.id] ?? String(view.settings.poolIssueSize)}
                  onChange={(e) => setCounts({ ...counts, [device.id]: e.target.value })}
                />
                <Button onClick={() => issue(device.id)} disabled={device.offline} title={device.offline ? "Device is offline — refill blocked" : undefined}>
                  Issue codes
                </Button>
              </div>
            }
          >
            <p className="mb-2 text-sm text-slate-600">
              <b>{reserved}</b> reserved · {used} used
            </p>
            <Table head={["Code", "Status", "Issued", "Used"]} empty={codes.length ? null : <Empty>No codes issued</Empty>}>
              {codes.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Code>{c.code}</Code>
                  </Td>
                  <Td>
                    <StatusBadge status={c.status} />
                  </Td>
                  <Td>{fmtTime(c.issuedAt)}</Td>
                  <Td>{fmtTime(c.usedAt)}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        ))}
      </div>
    </>
  );
}
