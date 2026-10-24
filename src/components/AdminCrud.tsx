"use client";

// Generic list + inline edit + create form for the admin reference tables.

import { useState } from "react";
import { api, errorText } from "@/lib/client";
import { useSession } from "./session";
import { useApi } from "./useApi";
import { Button, Card, Empty, Input, Notice, Select, Table, Td } from "./ui";

export interface Option {
  value: string;
  label: string;
}

export interface Column {
  key: string;
  label: string;
  type: "text" | "select" | "bool";
  options?: (row: Record<string, unknown>) => Option[];
  /** Can only be set when creating. */
  createOnly?: boolean;
  placeholder?: string;
  defaultValue?: unknown;
}

type Row = Record<string, unknown> & { id: string };

export function AdminCrud({
  entity,
  title,
  columns,
  sort,
}: {
  entity: string;
  title: string;
  columns: Column[];
  sort?: (a: Row, b: Row) => number;
}) {
  const { refresh } = useSession();
  const list = useApi<Row[]>(`/api/admin/${entity}`);
  const rows = list.data ?? [];

  const [draft, setDraft] = useState<Record<string, unknown>>(() => Object.fromEntries(columns.map((c) => [c.key, c.defaultValue ?? (c.type === "bool" ? true : "")])));
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = async () => list.reload();


  async function save(id: string, patch: Record<string, unknown>) {
    setMsg(null);
    try {
      await api(`/api/admin/${entity}/${id}`, { method: "PATCH", body: patch });
      setMsg({ tone: "ok", text: "Saved" });
      await Promise.all([load(), refresh()]);
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
      await load();
    }
  }

  async function create() {
    setMsg(null);
    const body = Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v === "" ? (k === "partnerId" ? null : v) : v]));
    try {
      await api(`/api/admin/${entity}`, { body });
      setMsg({ tone: "ok", text: "Created" });
      setDraft(Object.fromEntries(columns.map((c) => [c.key, c.defaultValue ?? (c.type === "bool" ? true : "")])));
      await Promise.all([load(), refresh()]);
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  }

  const cell = (c: Column, row: Row) => {
    const value = row[c.key];
    if (c.createOnly) {
      const label = c.options?.(row).find((o) => o.value === value)?.label;
      return <span className={c.key === "code" ? "font-mono" : ""}>{label ?? String(value ?? "—")}</span>;
    }
    if (c.type === "bool") {
      return <input type="checkbox" aria-label={c.label} checked={!!value} onChange={(e) => save(row.id, { [c.key]: e.target.checked })} className="h-5 w-5 accent-teal-700" />;
    }
    if (c.type === "select") {
      return (
        <Select aria-label={c.label} value={String(value ?? "")} onChange={(e) => save(row.id, { [c.key]: e.target.value || null })}>
          {c.options?.(row).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    }
    return (
      <Input
        aria-label={c.label}
        defaultValue={String(value ?? "")}
        onBlur={(e) => e.target.value !== String(value ?? "") && save(row.id, { [c.key]: e.target.value })}
      />
    );
  };

  return (
    <div className="space-y-4">
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {list.error && <Notice tone="error">{list.error}</Notice>}
      <Card title={title}>
        <Table head={columns.map((c) => c.label)} empty={rows.length ? null : <Empty>Nothing yet</Empty>}>
          {(sort ? [...rows].sort(sort) : rows).map((row) => (
            <tr key={`${row.id}-${JSON.stringify(row)}`}>
              {columns.map((c) => (
                <Td key={c.key}>{cell(c, row)}</Td>
              ))}
            </tr>
          ))}
        </Table>
      </Card>
      <Card title={`Add to ${title.toLowerCase()}`}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {columns.map((c) => (
            <label key={c.key} className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">{c.label}</span>
              {c.type === "bool" ? (
                <input type="checkbox" checked={!!draft[c.key]} onChange={(e) => setDraft({ ...draft, [c.key]: e.target.checked })} className="h-5 w-5 accent-teal-700" />
              ) : c.type === "select" ? (
                <Select value={String(draft[c.key] ?? "")} onChange={(e) => setDraft({ ...draft, [c.key]: e.target.value })}>
                  <option value="">—</option>
                  {c.options?.(draft).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input value={String(draft[c.key] ?? "")} placeholder={c.placeholder} onChange={(e) => setDraft({ ...draft, [c.key]: e.target.value })} />
              )}
            </label>
          ))}
        </div>
        <Button className="mt-3" onClick={create}>
          Add
        </Button>
      </Card>
    </div>
  );
}
