"use client";

import Link from "next/link";
import { useState } from "react";
import { ScanInput } from "@/components/ScanInput";
import { Button, Card, Code, Empty, Field, fmtTime, Input, Notice, PageTitle, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { api, errorText } from "@/lib/client";
import type { Reprint } from "@/lib/core/types";
import { notifyDataChanged } from "@/lib/events";

export default function ReprintPage() {
  const log = useApi<(Reprint & { userName: string })[]>("/api/reprint", { refreshOnChange: true });
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [ready, setReady] = useState<string | null>(null);

  async function submit() {
    setMsg(null);
    try {
      const r = await api<{ message: string }>("/api/reprint", { body: { code, reason } });
      setMsg({ tone: "ok", text: r.message });
      setReady(code);
      setReason("");
      notifyDataChanged();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  }

  return (
    <>
      <PageTitle title="Reprint a sticker" subtitle="Same code, never a new one. A reason is required and every reprint is logged." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="1. Pick the code">
          <ScanInput
            label="Lot or pack code"
            onScan={(c) => {
              setCode(c);
              setReady(null);
              setMsg(null);
            }}
            demoScreen="reprint"
          />
          {code && (
            <p className="mt-3 text-sm">
              Selected: <Code>{code}</Code>
            </p>
          )}
        </Card>
        <Card title="2. Reason">
          <Field label="Why is it being reprinted?">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Sticker torn while pasting" />
          </Field>
          <Button className="mt-3" onClick={submit} disabled={!code || !reason.trim()}>
            Log reprint
          </Button>
          {msg && (
            <Notice tone={msg.tone} className="mt-3">
              {msg.text}
            </Notice>
          )}
          {ready && (
            <Link href={`/print/code/${ready}`} className="mt-3 inline-block rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800">
              Open print view for {ready}
            </Link>
          )}
        </Card>
      </div>
      <Card title="Reprint log" className="mt-4">
        <Table head={["Time", "Code", "Reason", "By"]} empty={log.data && !log.data.length ? <Empty>No reprints yet</Empty> : null}>
          {log.data?.map((r) => (
            <tr key={r.id}>
              <Td className="whitespace-nowrap">{fmtTime(r.at)}</Td>
              <Td>
                <Code>{r.code}</Code>
              </Td>
              <Td>{r.reason}</Td>
              <Td>{r.userName}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
