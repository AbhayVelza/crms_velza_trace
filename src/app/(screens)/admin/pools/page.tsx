"use client";

// Batch codes: Velza Admin enters them by hand (automatic batch codes and pool refill are switched off).
// A code is exactly 6 characters A–Z / 0–9 and has no fixed flavour: the operator adds flavours when printing.

import { useState } from "react";
import { useAction } from "@/components/useAction";
import { useApi } from "@/components/useApi";
import { Button, Card, Code, Empty, fmtTime, Input, Notice, PageTitle, Table, Td } from "@/components/ui";
import { api, errorText } from "@/lib/client";

interface BatchCodeRow {
  id: string;
  code: string;
  createdAt: string;
  flavours: string[];
  lots: number;
  printedLots: number;
  locked: boolean;
}

const CODE_RE = /^[A-Z0-9]{6}$/;
const RULE = "Exactly 6 characters, A–Z or 0–9";

export default function BatchCodesPage() {
  const { data: view, error, reload } = useApi<{ codes: BatchCodeRow[] }>("/api/admin/batch-codes");
  const [newCode, setNewCode] = useState("");
  const [editing, setEditing] = useState<{ id: string; code: string } | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const [saving, run] = useAction(async (what: () => Promise<string>) => {
    setMsg(null);
    try {
      setMsg({ tone: "ok", text: await what() });
      reload();
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  });

  const add = () =>
    run(async () => {
      const r = await api<{ code: string }>("/api/admin/batch-codes", { body: { code: newCode } });
      setNewCode("");
      return `Added batch code ${r.code}`;
    });
  const save = (id: string, code: string) =>
    run(async () => {
      const r = await api<{ code: string }>(`/api/admin/batch-codes/${id}`, { method: "PATCH", body: { code } });
      setEditing(null);
      return `Saved batch code ${r.code}`;
    });
  const remove = (row: BatchCodeRow) => {
    if (!window.confirm(`Delete batch code ${row.code}?`)) return;
    run(async () => (await api<{ message: string }>(`/api/admin/batch-codes/${row.id}`, { method: "DELETE" })).message);
  };

  const typed = newCode.trim().toUpperCase();
  return (
    <>
      <PageTitle title="Batch codes" subtitle="Create, edit and delete batch codes. The operator picks one in the print wizard and adds its flavours. A batch with lots can't be edited or deleted." />
      {msg && <Notice tone={msg.tone} className="mb-4">{msg.text}</Notice>}
      {error && <Notice tone="error" className="mb-4">{error}</Notice>}
      <Card
        title="Batch codes"
        actions={
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Input aria-label="New batch code" placeholder="e.g. DH3493" maxLength={6} className="w-32 uppercase" value={newCode} onChange={(e) => setNewCode(e.target.value.toUpperCase())} title={RULE} />
            <Button type="submit" disabled={saving || !CODE_RE.test(typed)} title={RULE}>
              Add
            </Button>
          </form>
        }
      >
        <p className="mb-2 text-sm text-muted-foreground">{RULE}, unique.</p>
        <Table head={["Code", "Flavours", "Lots", "Created", ""]} empty={view && !view.codes.length ? <Empty>No batch codes yet</Empty> : null}>
          {view?.codes.map((row) => (
            <tr key={row.id}>
              <Td>
                {editing?.id === row.id ? (
                  <Input aria-label={`New code for ${row.code}`} maxLength={6} className="w-32 uppercase" value={editing.code} onChange={(e) => setEditing({ id: row.id, code: e.target.value.toUpperCase() })} />
                ) : (
                  <Code>{row.code}</Code>
                )}
              </Td>
              <Td>{row.flavours.length ? row.flavours.join(", ") : "—"}</Td>
              <Td>
                {row.lots}
                {row.printedLots ? ` (${row.printedLots} printed)` : ""}
              </Td>
              <Td>{fmtTime(row.createdAt)}</Td>
              <Td>
                <div className="flex justify-end gap-2">
                  {editing?.id === row.id ? (
                    <>
                      <Button variant="secondary" disabled={saving || !CODE_RE.test(editing.code)} onClick={() => save(row.id, editing.code)}>
                        Save
                      </Button>
                      <Button variant="secondary" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="secondary" disabled={saving || row.locked} title={row.locked ? "This batch already has lots — it can't be edited" : undefined} onClick={() => setEditing({ id: row.id, code: row.code })}>
                        Edit
                      </Button>
                      <Button variant="secondary" disabled={saving || row.locked} title={row.locked ? "This batch already has lots — it can't be deleted" : undefined} onClick={() => remove(row)}>
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </Td>
            </tr>
          ))}
        </Table>
        {view?.codes.some((r) => r.locked) && <p className="mt-2 text-xs text-muted-foreground">Edit and Delete are off for batches that already have lots: their lot and pack codes contain the batch code.</p>}
      </Card>
    </>
  );
}
