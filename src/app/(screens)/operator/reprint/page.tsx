"use client";

import Link from "next/link";
import { useState } from "react";
import { ScanInput } from "@/components/ScanInput";
import { useAction } from "@/components/useAction";
import { IconPrinter } from "@/components/icons";
import { Button, Card, Code, Empty, Field, fmtTime, Input, Notice, PageTitle, Table, Td } from "@/components/ui";
import { useApi } from "@/components/useApi";
import { api, errorText } from "@/lib/client";
import type { Reprint } from "@/lib/core/types";
import { notifyDataChanged } from "@/lib/events";

export default function ReprintPage() {
  const log = useApi<(Reprint & { userName: string; servedAt: string | null })[]>("/api/reprint", { refreshOnChange: true });
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  // The logged reprint that may be printed (once): its id and code.
  const [ready, setReady] = useState<{ id: string; code: string } | null>(null);
  const [reprinting, runSubmit] = useAction(submit);

  async function submit() {
    setMsg(null);
    try {
      const r = await api<{ message: string; reprint: Reprint }>("/api/reprint", { body: { code, reason } });
      setMsg({ tone: "ok", text: r.message });
      setReady({ id: r.reprint.id, code });
      setReason("");
      notifyDataChanged();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  }

  return (
    <>
      <PageTitle title="Reprint a sticker" subtitle="Same code, never a new one. A reason is required and every reprint is logged." />
      <div className="grid gap-4 lg:grid-cols-2 lg:gap-5">
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
          <p className="mt-2 text-xs text-muted-foreground">
            Reprinting a sticker of a quarantined lot takes the lot out of quarantine and back to QC: it must be verified again
            before it can be dispatched. A quarantined lot that can&apos;t be fixed is voided instead (Void lot).
          </p>
          <Button className="mt-3" onClick={runSubmit} disabled={!code || !reason.trim()} loading={reprinting}>
            Log reprint
          </Button>
          {msg && (
            <Notice tone={msg.tone} className="mt-3">
              {msg.text}
            </Notice>
          )}
          {ready && (
            <Link href={`/print/reprint/${ready.id}`} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary-hover">
              <IconPrinter size={17} />
              Print {ready.code} (once)
            </Link>
          )}
        </Card>
      </div>
      <Card title="Reprint log" className="mt-4">
        <Table head={["Time", "Code", "Reason", "By", "Printed"]} empty={log.data && !log.data.length ? <Empty>No reprints yet</Empty> : null}>
          {log.data?.map((r) => (
            <tr key={r.id}>
              <Td className="whitespace-nowrap text-muted-foreground">{fmtTime(r.at)}</Td>
              <Td>
                <Code>{r.code}</Code>
              </Td>
              <Td>{r.reason}</Td>
              <Td>{r.userName}</Td>
              <Td className="whitespace-nowrap text-muted-foreground">{r.servedAt ? fmtTime(r.servedAt) : "Not yet"}</Td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
