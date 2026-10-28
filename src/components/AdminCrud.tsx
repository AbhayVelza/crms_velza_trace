"use client";

// Generic list + inline edit + create form + delete for the admin tables.

import { useState, type ReactNode } from "react";
import { api, errorText } from "@/lib/client";
import { useSession } from "./session";
import { useApi } from "./useApi";
import { IconTrash } from "./icons";
import { Button, Card, Empty, Input, Notice, Select, Table, Td } from "./ui";

export interface Option {
  value: string;
  label: string;
}

export interface Column {
  key: string;
  label: string;
  /** password: write-only (set on create, "Set new" in the table); display: read-only via render(). */
  type: "text" | "select" | "bool" | "password" | "display";
  options?: (row: Record<string, unknown>) => Option[];
  /** Can only be set when creating. */
  createOnly?: boolean;
  /** Not shown in the create form. */
  editOnly?: boolean;
  /** Empty select value is sent as null. */
  nullable?: boolean;
  /** Field applies to this row (otherwise "—" and left out of the create form). */
  visible?: (row: Record<string, unknown>) => boolean;
  render?: (row: Row) => ReactNode;
  placeholder?: string;
  defaultValue?: unknown;
}

export type Row = Record<string, unknown> & { id: string };

export interface RowActionContext {
  reload: () => Promise<void>;
  setMsg: (m: { tone: "ok" | "error"; text: string } | null) => void;
}

const emptyDraft = (columns: Column[]) =>
  Object.fromEntries(columns.filter((c) => c.type !== "display" && !c.editOnly).map((c) => [c.key, c.defaultValue ?? (c.type === "bool" ? true : "")]));

function PasswordCell({ onSave }: { onSave: (pw: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  if (!open) {
    return (
      <Button variant="secondary" className="min-h-8 whitespace-nowrap px-2 py-1 text-xs" onClick={() => setOpen(true)}>
        Set new
      </Button>
    );
  }
  return (
    <div className="flex min-w-[14rem] gap-1">
      <Input type="password" aria-label="New password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password" />
      <Button className="min-h-8 px-2 py-1 text-xs" disabled={!pw} onClick={async () => (await onSave(pw)) && (setOpen(false), setPw(""))}>
        Save
      </Button>
      <Button variant="ghost" className="min-h-8 px-2 py-1 text-xs" onClick={() => (setOpen(false), setPw(""))}>
        Cancel
      </Button>
    </div>
  );
}

export function AdminCrud({
  entity,
  title,
  columns,
  sort,
  filter,
  toolbar,
  allowDelete = true,
  allowCreate = true,
  rowActions,
  intro,
}: {
  entity: string;
  title: string;
  columns: Column[];
  sort?: (a: Row, b: Row) => number;
  /** Show only matching rows in the table (e.g. one tier). */
  filter?: (row: Row) => boolean;
  /** Controls shown in the table header (e.g. the filter select). */
  toolbar?: ReactNode;
  allowDelete?: boolean;
  /** false = no generic "Add" form (the page has its own, e.g. the partner registration form). */
  allowCreate?: boolean;
  rowActions?: (row: Row, ctx: RowActionContext) => ReactNode;
  intro?: ReactNode;
}) {
  const { refresh } = useSession();
  const list = useApi<Row[]>(`/api/admin/${entity}`, { refreshOnChange: true });
  const rows = list.data ?? [];

  const [draft, setDraft] = useState<Record<string, unknown>>(() => emptyDraft(columns));
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = async () => list.reload();
  const shows = (c: Column, row: Record<string, unknown>) => !c.visible || c.visible(row);

  async function save(id: string, patch: Record<string, unknown>, okText = "Saved"): Promise<boolean> {
    setMsg(null);
    try {
      await api(`/api/admin/${entity}/${id}`, { method: "PATCH", body: patch });
      setMsg({ tone: "ok", text: okText });
      await Promise.all([load(), refresh()]);
      return true;
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
      await load();
      return false;
    }
  }

  async function remove(row: Row) {
    const name = String(row.name ?? row.code ?? row.id);
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;
    setMsg(null);
    try {
      const r = await api<{ message: string }>(`/api/admin/${entity}/${row.id}`, { method: "DELETE" });
      setMsg({ tone: "ok", text: r.message });
      await Promise.all([load(), refresh()]);
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  }

  async function create() {
    setMsg(null);
    const fields = columns.filter((c) => c.type !== "display" && !c.editOnly && shows(c, draft));
    const body = Object.fromEntries(fields.map((c) => [c.key, draft[c.key] === "" && c.nullable ? null : draft[c.key]]));
    try {
      await api(`/api/admin/${entity}`, { body });
      setMsg({ tone: "ok", text: "Created" });
      setDraft(emptyDraft(columns));
      await Promise.all([load(), refresh()]);
    } catch (e) {
      setMsg({ tone: "error", text: errorText(e) });
    }
  }

  const cell = (c: Column, row: Row) => {
    const value = row[c.key];
    if (!shows(c, row)) return <span className="text-subtle-foreground">—</span>;
    if (c.type === "display") return c.render?.(row) ?? String(value ?? "—");
    if (c.type === "password") return <PasswordCell onSave={(pw) => save(row.id, { [c.key]: pw }, "Password changed")} />;
    if (c.createOnly) {
      const label = c.options?.(row).find((o) => o.value === value)?.label;
      return <span className={c.key === "code" ? "font-mono" : ""}>{label ?? String(value ?? "—")}</span>;
    }
    if (c.type === "bool") {
      return <input type="checkbox" aria-label={c.label} checked={!!value} onChange={(e) => save(row.id, { [c.key]: e.target.checked })} className="h-5 w-5 accent-foreground" />;
    }
    if (c.type === "select") {
      return (
        <Select aria-label={c.label} value={String(value ?? "")} onChange={(e) => save(row.id, { [c.key]: e.target.value || null })}>
          {c.nullable && <option value="">—</option>}
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

  const hasActions = allowDelete || !!rowActions;
  const createColumns = columns.filter((c) => c.type !== "display" && !c.editOnly);
  const filtered = filter ? rows.filter(filter) : rows;
  const shown = sort ? [...filtered].sort(sort) : filtered;

  return (
    <div className="space-y-4">
      {intro}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {list.error && <Notice tone="error">{list.error}</Notice>}
      <Card title={`${title} (${shown.length})`} actions={toolbar}>
        <Table head={[...columns.map((c) => c.label), ...(hasActions ? [""] : [])]} empty={shown.length ? null : <Empty>{rows.length ? "Nothing matches the filter" : "Nothing yet"}</Empty>}>
          {shown.map((row) => (
            <tr key={`${row.id}-${JSON.stringify(row)}`}>
              {columns.map((c) => (
                <Td key={c.key}>{cell(c, row)}</Td>
              ))}
              {hasActions && (
                <Td>
                  <div className="flex flex-wrap justify-end gap-1">
                    {rowActions?.(row, { reload: load, setMsg })}
                    {allowDelete && (
                      <Button variant="ghost" className="min-h-8 px-3 py-1 text-xs text-danger hover:bg-danger-soft" onClick={() => remove(row)}>
                        <IconTrash size={15} />
                        Delete
                      </Button>
                    )}
                  </div>
                </Td>
              )}
            </tr>
          ))}
        </Table>
      </Card>
      {allowCreate && (
        <Card title={`Add to ${title.toLowerCase()}`}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {createColumns
              .filter((c) => shows(c, draft))
              .map((c) => (
                <label key={c.key} className="block text-sm">
                  <span className="mb-1.5 block text-[0.8125rem] font-semibold text-foreground-2">{c.label}</span>
                  {c.type === "bool" ? (
                    <input type="checkbox" checked={!!draft[c.key]} onChange={(e) => setDraft({ ...draft, [c.key]: e.target.checked })} className="h-5 w-5 accent-foreground" />
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
                    <Input
                      type={c.type === "password" ? "password" : "text"}
                      autoComplete={c.type === "password" ? "new-password" : "off"}
                      value={String(draft[c.key] ?? "")}
                      placeholder={c.placeholder}
                      onChange={(e) => setDraft({ ...draft, [c.key]: e.target.value })}
                    />
                  )}
                </label>
              ))}
          </div>
          <Button className="mt-3" onClick={create}>
            Add
          </Button>
        </Card>
      )}
    </div>
  );
}
