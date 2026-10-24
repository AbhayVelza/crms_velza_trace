"use client";

import { useState } from "react";
import { ScanInput } from "@/components/ScanInput";
import { Button, Card, Code, Field, Input, Notice, PageTitle } from "@/components/ui";
import { api, errorText } from "@/lib/client";
import { notifyDataChanged } from "@/lib/events";

export default function VoidPage() {
  const [lotCode, setLotCode] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function submit() {
    setMsg(null);
    try {
      const r = await api<{ message: string }>("/api/void", { body: { lotCode, reason } });
      setMsg({ tone: "ok", text: r.message });
      setLotCode("");
      setReason("");
      notifyDataChanged();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  }

  return (
    <>
      <PageTitle title="Void a lot" subtitle="For unpasted or misprinted lots (status GENERATED, PRINTED or QUARANTINED). The lot number is never reused." />
      <Card className="max-w-2xl">
        <ScanInput label="Lot code" onScan={(c) => (setLotCode(c), setMsg(null))} demoScreen="void" />
        {lotCode && (
          <div className="mt-4 space-y-3">
            <p className="text-sm">
              Lot: <Code>{lotCode}</Code> (its pack stickers are voided too)
            </p>
            <Field label="Reason (optional)">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Misprint, smudged" />
            </Field>
            <Button variant="danger" onClick={submit}>
              Void lot
            </Button>
          </div>
        )}
        {msg && (
          <Notice tone={msg.tone} className="mt-3">
            {msg.text}
          </Notice>
        )}
      </Card>
    </>
  );
}
